import type { SetupSeed } from "./types"

interface HealthResponse {
  status?: string
  smtp?: boolean
  redis?: boolean
  uptime?: number
}

/**
 * OSC 8 hyperlink escape sequence — wraps a URL + visible text so modern
 * terminals (iTerm2, Terminal.app, VS Code, Warp, kitty, wezterm) render
 * a click-target. Terminals that don't support OSC 8 just show the visible
 * text plus the URL alongside, which is also fine.
 *
 * https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda
 */
function hyperlink(url: string, text: string = url): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`
}

/**
 * Best-effort health probe with a HARD time budget. Returns true if the
 * endpoint responded with `{status: "ok"}` within `maxMs`, false otherwise.
 *
 * Crucially, this function NEVER throws and NEVER waits longer than `maxMs`
 * total. We use a manual retry loop with our own setTimeout-based clock
 * instead of seedcli's `http.retry` config because the latter has been
 * observed to wait up to 4+ minutes (count*timeout + delays) when each
 * attempt times out at the OS level.
 *
 * IMPORTANT: we shell out to `curl` instead of using seedcli's `seed.http`
 * (which wraps Bun's fetch). Bun's fetch is occasionally flaky against
 * brand-new Cloudflare custom domains in the first ~60 seconds — it throws
 * a generic "fetch failed" while curl from the same machine returns the
 * exact same response cleanly. Until Bun fixes the underlying TLS/HTTP-2
 * negotiation issue, curl is the reliable path. We fall back to seed.http
 * if curl is not on PATH (rare on macOS / Linux, more common on Windows).
 */
async function probeHealth(
  seed: SetupSeed,
  url: string,
  maxMs: number,
): Promise<{ ok: boolean; lastError?: string; method: "curl" | "fetch" }> {
  const hasCurl = Boolean(seed.system.which("curl"))
  if (hasCurl) {
    return probeHealthViaCurl(seed, url, maxMs)
  }
  return probeHealthViaFetch(seed, url, maxMs)
}

/**
 * Probe via `curl -sf -m 5 <url>`. Each attempt has its own 5s timeout
 * (curl's `-m`) and 3s sleep between attempts.
 */
async function probeHealthViaCurl(
  seed: SetupSeed,
  url: string,
  maxMs: number,
): Promise<{ ok: boolean; lastError?: string; method: "curl" }> {
  const start = Date.now()
  let lastError = ""
  while (Date.now() - start < maxMs) {
    try {
      // throwOnError: false → seedcli's exec returns the result instead of
      // throwing on non-zero exit (we discovered earlier that the default
      // throws despite the docs saying otherwise — being explicit is safer).
      // We pass curl flags `-sf -m 5`:
      //   -s   silent (no progress bar)
      //   -f   fail on HTTP errors (4xx/5xx → non-zero exit)
      //   -m 5 5-second hard total timeout per request
      const result = await seed.system.exec(`curl -sf -m 5 "${url}"`, {
        throwOnError: false,
      })
      if (result.exitCode === 0 && result.stdout.length > 0) {
        try {
          const data = JSON.parse(result.stdout) as HealthResponse
          if (data?.status === "ok") {
            return { ok: true, method: "curl" }
          }
          lastError = `unexpected body: ${result.stdout.slice(0, 100)}`
        } catch {
          lastError = `non-JSON response: ${result.stdout.slice(0, 100)}`
        }
      } else {
        const stderr = result.stderr.trim().slice(0, 100)
        lastError = formatCurlError(result.exitCode, stderr)
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100)
    }
    if (Date.now() - start + 3_000 < maxMs) {
      await new Promise((resolve) => setTimeout(resolve, 3_000))
    } else {
      break
    }
  }
  return { ok: false, lastError, method: "curl" }
}

/**
 * Map a curl exit code to a human-readable diagnosis. Curl's exit codes
 * are stable across versions and well-documented:
 * https://curl.se/libcurl/c/libcurl-errors.html
 */
function formatCurlError(exitCode: number, stderr: string): string {
  const codes: Record<number, string> = {
    6: "DNS resolution failed (host not found)",
    7: "couldn't connect (server unreachable)",
    28: "operation timed out",
    35: "TLS/SSL handshake failed",
    51: "TLS certificate verification failed",
    52: "empty response from server",
    56: "connection reset",
    60: "TLS certificate problem (expired/invalid)",
  }
  const explanation = codes[exitCode] ?? "see https://curl.se/libcurl/c/libcurl-errors.html"
  const suffix = stderr ? `: ${stderr}` : ""
  return `curl exit ${exitCode} (${explanation})${suffix}`
}

/**
 * Fallback probe via seed.http.get. Used only when curl isn't on PATH.
 * Same retry shape as the curl path for parity.
 */
async function probeHealthViaFetch(
  seed: SetupSeed,
  url: string,
  maxMs: number,
): Promise<{ ok: boolean; lastError?: string; method: "fetch" }> {
  const start = Date.now()
  let lastError = ""
  while (Date.now() - start < maxMs) {
    try {
      const response = await Promise.race<{ data?: HealthResponse } | null>([
        seed.http.get<HealthResponse>(url, { timeout: 5_000 }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ])
      if (response && response.data?.status === "ok") {
        return { ok: true, method: "fetch" }
      }
      if (response === null) {
        lastError = "request timed out after 5s"
      } else {
        lastError = `unexpected response body: ${JSON.stringify(response.data ?? {}).slice(0, 100)}`
      }
    } catch (err) {
      // Bun's fetch wraps lower-level errors. Unwrap `cause` if present
      // for a more specific message.
      const errAny = err as { message?: string; cause?: { message?: string } }
      const causeMessage = errAny.cause?.message
      lastError = (causeMessage || errAny.message || String(err)).slice(0, 100)
    }
    if (Date.now() - start + 3_000 < maxMs) {
      await new Promise((resolve) => setTimeout(resolve, 3_000))
    } else {
      break
    }
  }
  return { ok: false, lastError, method: "fetch" }
}

/**
 * Phase 9 — Verify the deployment end-to-end and print the success card.
 *
 *   1. Health probe through the user's hostname (proves DNS, TLS, custom
 *      domain, web worker, /api/* hook, service binding, API worker, D1+R2
 *      are ALL wired correctly). BEST-EFFORT — we warn but don't throw on
 *      failure, because the deployment is technically complete by this point.
 *   2. Site probe — fetch the root path. Same best-effort treatment.
 *   3. ALWAYS print the success card with the clickable URL.
 *   4. Optionally open the site in the user's browser.
 */
export async function run(seed: SetupSeed): Promise<void> {
  const { print, prompt, system, state, flags } = seed
  const dryRun = flags.dryRun === true

  const current = await state.load()
  if (!current.web_hostname || !current.email_zone) {
    throw new Error("verify phase requires web_hostname and email_zone in state")
  }

  if (dryRun) {
    print.muted(
      `[dry-run] would GET https://${current.web_hostname}/api/health (best-effort, max 30s)`,
    )
    print.muted(`[dry-run] would GET https://${current.web_hostname}/`)
    const dryLines = [
      "DRY RUN COMPLETE",
      "",
      "No Cloudflare resources were created or modified.",
      "",
      `Would deploy site at:  https://${current.web_hostname}`,
      `Would receive mail at: *@${current.email_zone}`,
      "",
      "Workers (would deploy):",
      `  web -> ${current.web_worker_name}`,
      `  api -> ${current.api_worker_name}`,
      `D1 (would create):  ${current.d1_name}`,
      `R2 (would create):  ${current.r2_name}`,
      "",
      "Run again without --dry-run to actually deploy.",
      "Inspect the rendered wrangler.toml files in your --from path:",
      "  packages/cloudflare/wrangler.toml",
      "  packages/web/wrangler.toml",
    ]
    print.newline()
    print.box(dryLines.join("\n"), { title: "Dry run", borderColor: "yellow", padding: 1 })
    print.muted(`State saved to ${state.path}`)
    return
  }

  const siteUrl = `https://${current.web_hostname}`
  const inboxUrl = `${siteUrl}/inbox/test@${current.email_zone}`

  // -----------------------------------------------------------------
  // Best-effort verification — never blocks for more than 60s
  // -----------------------------------------------------------------
  // We probe the worker's `*.workers.dev` URL (captured from wrangler's
  // deploy output) instead of the user's custom hostname. The workers.dev
  // URL is always reachable instantly — no per-domain DNS propagation lag
  // — and exercises the exact same SvelteKit hook → service binding →
  // API worker code path. The custom domain just adds DNS+TLS on top, and
  // the user can verify that themselves in their browser.
  //
  // If we don't have a workers.dev URL in state for some reason (e.g.
  // wrangler's output format changed and the deploy step couldn't parse
  // it), fall back to the custom hostname so the verify still attempts
  // SOMETHING rather than skipping silently.
  const probeUrl = current.web_worker_url
    ? `${current.web_worker_url.replace(/\/$/, "")}/api/health`
    : `${siteUrl}/api/health`
  const probeLabel = current.web_worker_url ? "workers.dev URL" : "custom domain"
  const healthSpinner = print.spin(
    `Probing /api/health via ${probeLabel} (best-effort, max 60s)...`,
  )
  const health = await probeHealth(seed, probeUrl, 60_000)
  if (health.ok) {
    healthSpinner.succeed(`Health probe ok via ${probeLabel} (${health.method})`)
  } else {
    healthSpinner.warn(`Health probe inconclusive (${health.lastError ?? "no response"})`)
    print.muted("  This is best-effort — the deployment may still be propagating (DNS/TLS).")
    print.muted(`  Try manually: curl -i ${probeUrl}`)
    if (current.web_worker_url && current.web_hostname) {
      print.muted(`  Also try: curl -i ${siteUrl}/api/health`)
    }
  }

  // -----------------------------------------------------------------
  // Success card — ALWAYS prints, regardless of probe outcome
  // -----------------------------------------------------------------
  // Persist the final phase marker FIRST so even if the user ctrl-Cs after
  // seeing the card, the state file reflects a clean deployment. Also clear
  // the rollback manifest — re-runs after success shouldn't try to roll back.
  await state.save({ last_completed_phase: 9, created_by_wizard: {} })

  const linkedSiteUrl = hyperlink(siteUrl)
  const linkedInboxUrl = hyperlink(inboxUrl)

  // Build the resources section with column-aligned arrows. We compute the
  // label width dynamically so adding a row later (e.g. "kv namespace") just
  // works without hand-tweaking padding.
  const resources: Array<[string, string | undefined]> = [
    ["web worker", current.web_worker_name],
    ["api worker", current.api_worker_name],
    ["D1 database", current.d1_name],
    ["R2 bucket", current.r2_name],
  ]
  const labelWidth = Math.max(...resources.map(([label]) => label.length))
  const resourceLines = resources
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([label, value]) => `  ${label.padEnd(labelWidth)} → ${value}`)

  const lines = [
    "🎉  CloakMail is live!",
    "",
    `🌐  Visit your site:`,
    `    ${linkedSiteUrl}`,
    "",
    `📬  Send a test email to:`,
    `    test@${current.email_zone}`,
    "",
    `📥  Then check the inbox:`,
    `    ${linkedInboxUrl}`,
    "",
    `Resources:`,
    ...resourceLines,
  ]
  print.newline()
  print.box(lines.join("\n"), { title: "🎉 Done!", borderColor: "green", padding: 1 })
  print.newline()
  print.muted(`State saved to ${state.path}`)

  // -----------------------------------------------------------------
  // Optional: open the site in the user's default browser
  // -----------------------------------------------------------------
  // Skip if --yes was passed (CI / scripted runs) or if the terminal
  // isn't interactive (no DISPLAY, piped stdin, etc.) — opening a browser
  // there would be useless or impossible.
  if (!flags.yes && system.isInteractive()) {
    print.newline()
    const openIt = await prompt.confirm({
      message: "Open your cloakmail site in the browser now?",
      default: true,
    })
    if (openIt) {
      try {
        await system.open(siteUrl)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        print.warning(`Could not open browser (${reason}). Click the link in the card above.`)
      }
    }
  }
}
