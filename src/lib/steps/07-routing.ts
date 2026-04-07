import type { SetupSeed } from "./types"

/**
 * Phase 7 — Wire up Email Routing (plan steps 19-21).
 *
 *   1. Enable Email Routing on the email zone if it isn't already.
 *   2. Poll the DNS verification endpoint until the MX records are healthy
 *      (90s timeout).
 *   3. Upsert the catch-all rule pointing at the API worker.
 *
 * Steps 1 and 3 are idempotent — `getEmailRouting` lets us skip the enable
 * if it's already on, and `upsertCatchAll` does its own GET-then-PUT/POST
 * routing.
 */
export async function run(seed: SetupSeed): Promise<void> {
  const { print, cloudflare, state, flags } = seed
  const dryRun = flags.dryRun === true

  const current = await state.load()
  if (!current.email_zone_id || !current.api_worker_name) {
    throw new Error("routing phase requires email_zone_id and api_worker_name in state")
  }
  const zoneId = current.email_zone_id
  const workerName = current.api_worker_name

  if (dryRun) {
    print.muted(`[dry-run] would GET /zones/${zoneId}/email/routing`)
    print.muted(`[dry-run] would POST /zones/${zoneId}/email/routing/enable (if disabled)`)
    print.muted(`[dry-run] would poll /zones/${zoneId}/email/routing/dns until MX verified (90s)`)
    print.muted(
      `[dry-run] would PUT /zones/${zoneId}/email/routing/rules/catch_all → worker '${workerName}'`,
    )
    return
  }

  // Step 19 — enable Email Routing if needed.
  // Track whether WE enabled it (vs it was already on) so the rollback step
  // only disables routing on this zone if cloakmail was the one that enabled
  // it. We never want to disable Email Routing on a zone where the user had
  // it on for some other reason.
  const enableSpinner = print.spin("Checking Email Routing status...")
  try {
    const settings = await cloudflare.getEmailRouting(zoneId)
    if (settings.enabled) {
      enableSpinner.succeed("Email Routing already enabled")
    } else {
      enableSpinner.text = "Enabling Email Routing..."
      await cloudflare.enableEmailRouting(zoneId)
      await state.recordCreated({ email_routing_enabled_by_us: true })
      enableSpinner.succeed("Email Routing enabled")
    }
  } catch (err) {
    enableSpinner.fail("Email Routing enable failed")
    throw err
  }

  // Step 20 — poll for MX verification (max 90s).
  const mxSpinner = print.spin("Verifying MX records (up to 90s)...")
  try {
    const verified = await cloudflare.pollMxVerified(zoneId, 90_000)
    if (!verified) {
      mxSpinner.fail("MX records did not verify within 90s")
      throw new Error(
        "Email Routing MX records did not verify in time. " +
          "Check the DNS section of the Email Routing dashboard, then re-run cloakmail-cli setup.",
      )
    }
    mxSpinner.succeed("MX records verified")
  } catch (err) {
    if (mxSpinner.isSpinning) mxSpinner.fail("MX verification failed")
    throw err
  }

  // Step 21 — upsert the catch-all rule pointing at the API worker.
  // We always record this as "ours" because cloakmail's catch-all rule
  // points specifically at our api worker — even if a catch-all rule
  // existed before, we just overwrote it. Rollback disables it (rather
  // than deleting, since CF requires a catch-all to exist when routing
  // is enabled).
  const ruleSpinner = print.spin(`Wiring catch-all rule to ${workerName}...`)
  try {
    await cloudflare.upsertCatchAll(zoneId, workerName)
    await state.recordCreated({ catch_all_rule_created: true })
    ruleSpinner.succeed("Catch-all rule configured")
  } catch (err) {
    ruleSpinner.fail("Catch-all rule failed")
    throw err
  }
}
