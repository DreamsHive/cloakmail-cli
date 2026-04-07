import { defaultApiWorkerName, defaultD1Name, defaultR2Name, defaultWebWorkerName } from "../names"
import type { SetupSeed } from "./types"

/**
 * Build a Cloudflare dashboard URL that opens the create-custom-token form
 * with the token name pre-filled. The user still has to manually pick the
 * 6 scopes from the list — see KNOWN LIMITATION below.
 *
 * KNOWN LIMITATION: Cloudflare's `?permissionGroupKeys=...` URL parameter
 * exists in the official docs but the dashboard silently ignores it for
 * third-party callers. We tried the documented format
 * `[{"key":"<slug>","type":"edit"}]` with several plausible snake_case slugs
 * (`workers_scripts`, `d1`, `workers_r2`, `email_routing_rule`,
 * `zone_dns_settings`, etc.) and the Permissions list always rendered empty
 * — the only param Cloudflare actually honors is `name=...`. The deep-link
 * template feature appears to be gated for first-party Cloudflare apps
 * (wrangler) until they document the slugs publicly.
 *
 * For now we just open the bare token page with a pre-filled name and
 * expect the user to manually pick the 6 scopes from the printed list.
 */
function buildTokenDashboardUrl(): string {
  const params = new URLSearchParams({ name: "cloakmail-cli" })
  return `https://dash.cloudflare.com/profile/api-tokens?${params.toString()}`
}

/**
 * Phase 2 — Collect every input the wizard needs (plan steps 4-9).
 *
 * Inputs are written to `seed.state` so subsequent runs can resume / re-verify
 * without re-asking. The token is only persisted when --save-token is set;
 * otherwise it lives in memory only.
 *
 * Cached state takes priority: if `email_zone` is already in state and
 * `--reset` was not passed, we re-use it without prompting. The user can
 * always `--reset` to start fresh.
 */
export async function run(seed: SetupSeed): Promise<void> {
  const { print, prompt, state, cloudflare, wrangler, system, flags } = seed
  const setupFlags = flags
  const dryRun = setupFlags.dryRun === true

  // Plan step 9 already mandates we save state at the end of the prompts
  // phase. We pre-load existing state up front so resumes can short-circuit.
  if (setupFlags.reset) {
    await state.clear()
  }
  const cached = await state.load()

  // -----------------------------------------------------------------
  // Token (asked first because every subsequent step needs it)
  // -----------------------------------------------------------------
  //
  // UX: we open the dashboard token page with the token name pre-filled
  // (`?name=cloakmail-cli`) and print the 6 required scopes as a checklist
  // the user picks from manually. We can't auto-populate the scope list
  // itself — see KNOWN LIMITATION on `buildTokenDashboardUrl()` above for
  // why the official `permissionGroupKeys` URL parameter doesn't work for
  // third-party callers. Cloudflare's OAuth is also locked to first-party
  // apps so we can't do a fully headless flow either.
  const TOKEN_DASHBOARD_URL = buildTokenDashboardUrl()

  let token = cached.api_token ?? ""
  let accountId = cached.account_id ?? ""

  print.newline()
  print.info("Step 1: Cloudflare API token")

  if (!token) {
    print.muted("Cloakmail needs a Cloudflare API token with these 7 scopes.")
    print.muted("In the form, click '+ Add more' for each row and pick:")
    print.newline()
    print.muted("  1. Account → Workers Scripts        → Edit")
    print.muted("  2. Account → D1                     → Edit")
    print.muted("  3. Account → Workers R2 Storage     → Edit")
    print.muted("  4. Zone    → Workers Routes         → Edit")
    print.muted("  5. Zone    → Email Routing Rules    → Edit")
    print.muted("  6. Zone    → DNS                    → Edit")
    print.muted("  7. Zone    → Zone Settings          → Edit")
    print.muted("     (the 'enable Email Routing' API call requires Zone Settings,")
    print.muted("      not Email Routing Rules — this is a Cloudflare quirk)")
    print.newline()
    print.muted("Token page (token name pre-filled):")
    print.muted(TOKEN_DASHBOARD_URL)
    print.newline()

    // Auto-open the browser. Default to Yes so the user just hits Enter.
    // Skip in non-interactive contexts (CI, piped stdin) where launching a
    // browser would be useless.
    if (system.isInteractive()) {
      const openIt = await prompt.confirm({
        message: "Open the Cloudflare token page in your browser now?",
        default: true,
      })
      if (openIt) {
        try {
          await system.open(TOKEN_DASHBOARD_URL)
          print.muted(
            "Browser opened. Add the 6 scopes above, click 'Continue to summary' → 'Create Token', then copy + paste it below.",
          )
        } catch (err) {
          // open() can fail in headless / SSH / no-DISPLAY environments.
          // Not fatal — just print the URL again so the user can click it
          // from their terminal.
          const reason = err instanceof Error ? err.message : String(err)
          print.warning(`Could not open browser (${reason}). Click the URL above instead.`)
        }
      }
    }
  }

  if (dryRun) {
    // In dry-run we accept any non-empty string as the token (or skip
    // entirely if cached). Token is never sent anywhere — there's no
    // verifyToken call.
    if (!token) {
      token = await prompt.password({
        message: "Cloudflare API token (any value — dry-run skips verification)",
        validate: (value) => value.length >= 1 || "Type anything",
      })
    }
    accountId = accountId || "DRY-RUN-ACCOUNT-ID"
    cloudflare.setToken(token)
    wrangler.setToken(token)
    wrangler.setAccountId(accountId)
    print.muted(`[dry-run] skipping token verify; using account_id=${accountId}`)
  } else {
    // Loop until we get a token that verifies. Re-prompt on failure rather
    // than exiting so the user doesn't have to start over.
    while (true) {
      if (!token) {
        token = await prompt.password({
          message: "Cloudflare API token",
          validate: (value) => value.length >= 8 || "Token looks too short",
        })
      }
      cloudflare.setToken(token)
      wrangler.setToken(token)
      const tokenSpinner = print.spin("Verifying token...")
      try {
        const verified = await cloudflare.verifyToken()
        accountId = verified.accountId
        // Pass the account ID to wrangler so it skips the GET /memberships
        // lookup that requires User → Memberships → Read scope (which we
        // deliberately don't ask for).
        wrangler.setAccountId(accountId)
        tokenSpinner.succeed(`Token verified (account ${accountId || "unknown"})`)
        break
      } catch (err) {
        tokenSpinner.fail("Token verification failed")
        const reason = err instanceof Error ? err.message : String(err)
        print.error(reason)
        print.muted("Re-create the token with the listed scopes and try again.")
        token = ""
      }
    }

    // -----------------------------------------------------------------
    // Account-level prerequisites
    // -----------------------------------------------------------------
    // Catch the one-time-per-account Cloudflare settings BEFORE any
    // resources are created, so the user gets actionable hints instead of
    // a half-deployed install + dirty rollback. We can only do this AFTER
    // verifyToken returns the account_id, which is why it lives here in
    // phase 2 instead of phase 1 (validate).
    const prereqsSpinner = print.spin("Checking account prerequisites...")
    try {
      const prereqs = await cloudflare.checkAccountPrereqs(accountId)
      const missing: Array<{ label: string; hint: string }> = []
      if (!prereqs.workersSubdomain) {
        missing.push({
          label: "workers.dev subdomain not registered",
          hint:
            `Open https://dash.cloudflare.com/${accountId}/workers-and-pages ` +
            "and pick a subdomain when prompted (e.g. 'yourname'). " +
            "Or run `bunx wrangler subdomain <yourname>`. One-time setup, takes ~20 seconds.",
        })
      }
      if (!prereqs.r2Enabled) {
        missing.push({
          label: "R2 not enabled on this account",
          hint:
            "Open https://dash.cloudflare.com/?to=/:account/r2 and click " +
            "'Enable R2' / 'Purchase R2 Plan' (free tier available, no charge unless you exceed it).",
        })
      }
      if (missing.length > 0) {
        prereqsSpinner.fail("Account prerequisites are missing")
        for (const item of missing) {
          print.error(`  ✗ ${item.label}`)
          print.muted(`    ${item.hint}`)
        }
        throw new Error(
          `${missing.length} account prerequisite(s) missing. Fix in the dashboard, then re-run setup.`,
        )
      }
      prereqsSpinner.succeed(
        `Account prereqs ok (workers.dev=${prereqs.workersSubdomain}, R2 enabled)`,
      )
    } catch (err) {
      if (prereqsSpinner.isSpinning) prereqsSpinner.fail("Account prerequisite check failed")
      throw err
    }
  }

  // -----------------------------------------------------------------
  // Email zone
  // -----------------------------------------------------------------
  print.newline()
  print.info("Step 2: Email zone")
  print.muted("The domain users will receive mail at, e.g. example.com")
  print.newline()

  let emailZone = cached.email_zone ?? ""
  let emailZoneId = cached.email_zone_id ?? ""

  if (dryRun) {
    emailZone = await prompt.input({
      message: "Email zone (e.g. example.com) [dry-run skips zone lookup]",
      default: emailZone || undefined,
      validate: (value) =>
        /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value) ||
        "Enter a valid domain (e.g. example.com)",
    })
    emailZoneId = emailZoneId || "DRY-RUN-EMAIL-ZONE-ID"
    print.muted(`[dry-run] skipping zone lookup; using email_zone_id=${emailZoneId}`)
  } else {
    while (true) {
      emailZone = await prompt.input({
        message: "Email zone (e.g. example.com)",
        default: emailZone || undefined,
        validate: (value) =>
          /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value) ||
          "Enter a valid domain (e.g. example.com)",
      })
      const zoneSpinner = print.spin(`Looking up ${emailZone} in your account...`)
      try {
        const zones = await cloudflare.listZones(emailZone)
        const match = zones.find((z) => z.name === emailZone)
        if (!match) {
          zoneSpinner.fail(`No zone named ${emailZone} in this account`)
          print.muted(
            "Add the domain at https://dash.cloudflare.com/?to=/:account/add-site first, then re-run.",
          )
          emailZone = ""
          continue
        }
        emailZoneId = match.id
        zoneSpinner.succeed(`Found zone ${emailZone} (id ${emailZoneId})`)
        break
      } catch (err) {
        zoneSpinner.fail("Zone lookup failed")
        const reason = err instanceof Error ? err.message : String(err)
        print.error(reason)
        emailZone = ""
      }
    }
  }

  // -----------------------------------------------------------------
  // Web hostname
  // -----------------------------------------------------------------
  print.newline()
  print.info("Step 3: Web hostname")
  print.muted(
    "The single hostname users will visit. Can be the apex, a subdomain, or another zone.",
  )
  print.newline()

  let webHostname = cached.web_hostname ?? ""
  let webZoneId = cached.web_zone_id ?? ""

  if (dryRun) {
    if (!webHostname) {
      const choice = await prompt.select<string>({
        message: "Web hostname [dry-run skips zone resolve]",
        choices: [
          { name: emailZone, value: emailZone },
          { name: `temp.${emailZone}`, value: `temp.${emailZone}` },
          { name: `inbox.${emailZone}`, value: `inbox.${emailZone}` },
          { name: "Type a custom hostname...", value: "__custom__" },
        ],
        default: emailZone,
      })
      if (choice === "__custom__") {
        webHostname = await prompt.input({
          message: "Custom hostname",
          validate: (value) =>
            /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value) ||
            "Enter a valid hostname",
        })
      } else {
        webHostname = choice
      }
    }
    webZoneId = webZoneId || "DRY-RUN-WEB-ZONE-ID"
    print.muted(`[dry-run] skipping web hostname zone resolve; using web_zone_id=${webZoneId}`)
  } else {
    while (true) {
      if (!webHostname) {
        const choice = await prompt.select<string>({
          message: "Web hostname",
          choices: [
            { name: emailZone, value: emailZone },
            { name: `temp.${emailZone}`, value: `temp.${emailZone}` },
            { name: `inbox.${emailZone}`, value: `inbox.${emailZone}` },
            { name: "Type a custom hostname...", value: "__custom__" },
          ],
          default: emailZone,
        })
        if (choice === "__custom__") {
          webHostname = await prompt.input({
            message: "Custom hostname",
            validate: (value) =>
              /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value) ||
              "Enter a valid hostname",
          })
        } else {
          webHostname = choice
        }
      }
      const hostSpinner = print.spin(`Resolving zone for ${webHostname}...`)
      try {
        // The web hostname's zone is whichever registered zone is its parent.
        // We try increasingly broader suffixes (foo.bar.example.com -> bar.example.com -> example.com)
        // until we find a match in the user's account.
        const labels = webHostname.split(".")
        let resolved = false
        for (let i = 0; i < labels.length - 1; i++) {
          const candidate = labels.slice(i).join(".")
          const zones = await cloudflare.listZones(candidate)
          const match = zones.find((z) => z.name === candidate)
          if (match) {
            webZoneId = match.id
            resolved = true
            break
          }
        }
        if (!resolved) {
          hostSpinner.fail(`No parent zone for ${webHostname} in this account`)
          webHostname = ""
          continue
        }
        hostSpinner.succeed(`Web zone ${webZoneId}`)
        break
      } catch (err) {
        hostSpinner.fail("Web hostname zone lookup failed")
        const reason = err instanceof Error ? err.message : String(err)
        print.error(reason)
        webHostname = ""
      }
    }
  }

  // -----------------------------------------------------------------
  // Advanced settings
  // -----------------------------------------------------------------
  let apiWorkerName = cached.api_worker_name ?? defaultApiWorkerName()
  let webWorkerName = cached.web_worker_name ?? defaultWebWorkerName()
  let d1Name = cached.d1_name ?? defaultD1Name()
  let r2Name = cached.r2_name ?? defaultR2Name()
  let emailTtlSeconds = cached.email_ttl_seconds ?? "86400"
  let maxEmailSizeMb = cached.max_email_size_mb ?? "10"
  let appName = cached.app_name ?? "CloakMail"

  print.newline()
  const showAdvanced = await prompt.confirm({
    message: "Show advanced settings (worker names, D1, R2, TTL)?",
    default: false,
  })
  if (showAdvanced) {
    apiWorkerName = await prompt.input({ message: "API worker name", default: apiWorkerName })
    webWorkerName = await prompt.input({ message: "Web worker name", default: webWorkerName })
    d1Name = await prompt.input({ message: "D1 database name", default: d1Name })
    r2Name = await prompt.input({ message: "R2 bucket name", default: r2Name })
    emailTtlSeconds = await prompt.input({
      message: "Email TTL (seconds)",
      default: emailTtlSeconds,
      validate: (value) => /^\d+$/.test(value) || "Must be an integer",
    })
    maxEmailSizeMb = await prompt.input({
      message: "Max email size (MB)",
      default: maxEmailSizeMb,
      validate: (value) => /^\d+$/.test(value) || "Must be an integer",
    })
    appName = await prompt.input({ message: "App name (UI title)", default: appName })
  }

  // -----------------------------------------------------------------
  // Summary + confirm
  // -----------------------------------------------------------------
  print.newline()
  print.box(
    [
      `Email zone:    ${emailZone}`,
      `Web hostname:  ${webHostname}`,
      `Account:       ${accountId || "(unknown)"}`,
      "",
      `API worker:    ${apiWorkerName}`,
      `Web worker:    ${webWorkerName}`,
      `D1 database:   ${d1Name}`,
      `R2 bucket:     ${r2Name}`,
      "",
      `Email TTL:     ${emailTtlSeconds}s`,
      `Max size:      ${maxEmailSizeMb} MB`,
      `App name:      ${appName}`,
    ].join("\n"),
    { title: "Cloakmail setup summary", borderColor: "cyan", padding: 1 },
  )

  if (!setupFlags.yes) {
    const proceed = await prompt.confirm({ message: "Proceed with these values?", default: true })
    if (!proceed) {
      throw new Error("Setup cancelled by user")
    }
  }

  // -----------------------------------------------------------------
  // Persist
  // -----------------------------------------------------------------
  await state.save({
    email_zone: emailZone,
    email_zone_id: emailZoneId,
    web_hostname: webHostname,
    web_zone_id: webZoneId,
    account_id: accountId,
    api_worker_name: apiWorkerName,
    web_worker_name: webWorkerName,
    d1_name: d1Name,
    r2_name: r2Name,
    email_ttl_seconds: emailTtlSeconds,
    max_email_size_mb: maxEmailSizeMb,
    app_name: appName,
    // Token only goes to disk when --save-token is on.
    api_token: setupFlags.saveToken ? token : undefined,
  })
}
