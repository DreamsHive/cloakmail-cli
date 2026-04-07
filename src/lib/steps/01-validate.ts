import type { SetupSeed } from "./types"

/**
 * Phase 1 — Validate prerequisites.
 *
 * Plan steps 1-3:
 *   1. wrangler is callable (binary exists in node_modules or on PATH)
 *   2. Network reachability — HEAD against api.cloudflare.com
 *   3. State file readable — if it exists, it parses cleanly
 *
 * Token verification (the third "validate" item from the plan) lives in the
 * prompts phase because we don't have a token yet at this point. Splitting
 * it that way also keeps the step boundary clean: validate covers things we
 * can check without ANY user input.
 */
export async function run(seed: SetupSeed): Promise<void> {
  const { print, system, http, state, flags } = seed
  const dryRun = flags.dryRun === true

  // Step 1 — wrangler binary present.
  // Resolved as a separate spinner so the user sees an obvious checklist
  // of prereqs rather than a single opaque "validating..." line.
  const binSpinner = print.spin("Checking wrangler is installed...")
  const wranglerPath = system.which("wrangler")
  if (wranglerPath) {
    binSpinner.succeed(`wrangler found at ${wranglerPath}`)
  } else if (dryRun) {
    // In dry-run we never actually invoke wrangler, so a missing binary
    // is just a heads-up — useful for showing the user they'll need to
    // install it before doing a real run.
    binSpinner.warn("[dry-run] wrangler not found; would be required for a real run")
  } else {
    // wrangler is a regular dep of cloakmail-cli, so this only fires when
    // the dep tree is broken or someone is running a clone they forgot to
    // `bun install`. We don't fail hard yet — the wrangler extension's
    // node_modules-walk fallback may still find it.
    binSpinner.warn("wrangler not on PATH; falling back to bundled node_modules/.bin/wrangler")
  }

  // Step 2 — network reachability. We hit `/client/v4/ips`, a documented
  // unauthenticated endpoint that returns the list of Cloudflare IP ranges.
  // It's the canonical "is the CF API up" endpoint and reliably returns
  // 200 OK without any auth header. Hitting the API root (`/client/v4/`)
  // does NOT work because Cloudflare returns 400 Bad Request there, and
  // the seedcli http client treats that as a failure even though the
  // server was clearly reached.
  //
  // We also defensively treat ANY error that has a status code as
  // "reachable" — getting a 401/403/400 means we successfully made the
  // round trip; we only care about timeouts / DNS / connection refused.
  // Skipped in dry-run because we never make any real CF API calls.
  if (dryRun) {
    print.muted("[dry-run] skipping network reachability check")
  } else {
    const netSpinner = print.spin("Checking Cloudflare API reachability...")
    try {
      await http.get("https://api.cloudflare.com/client/v4/ips", { timeout: 5_000 })
      netSpinner.succeed("Cloudflare API is reachable")
    } catch (err) {
      // If the error has a `status` field (HTTP error), the server is
      // reachable — we just got a non-2xx response. That's fine for a
      // pre-flight check; we only want to bail on real network failures.
      const status = (err as { status?: number; response?: { status?: number } })?.status
      const responseStatus = (err as { response?: { status?: number } })?.response?.status
      if (typeof status === "number" || typeof responseStatus === "number") {
        netSpinner.succeed(
          `Cloudflare API is reachable (got HTTP ${status ?? responseStatus} from /ips, server is up)`,
        )
      } else {
        netSpinner.fail("Cannot reach https://api.cloudflare.com/client/v4/ips")
        const reason = err instanceof Error ? err.message : String(err)
        throw new Error(
          `Network check failed: ${reason}\n` +
            "Verify your internet connection and that api.cloudflare.com is not blocked.",
        )
      }
    }
  }

  // Step 3 — state file readability. We trigger a load() up front so a
  // corrupt JSON file is surfaced here (with a clear --reset hint) instead
  // of crashing in the middle of the prompts phase.
  const stateSpinner = print.spin("Loading saved state...")
  try {
    await state.load()
    stateSpinner.succeed(`State file at ${state.path}`)
  } catch (err) {
    stateSpinner.fail(`Could not read state file at ${state.path}`)
    throw err
  }
}
