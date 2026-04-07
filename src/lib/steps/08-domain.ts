import type { SetupSeed } from "./types"

/**
 * Phase 8 — Bind the Workers Custom Domain (plan step 22).
 *
 * The web worker is the only one that gets a custom domain — the API
 * worker is reachable only through the service binding from inside the
 * web worker, by design.
 *
 * Conflict handling:
 *   - 201 Created or "already bound to this exact service" → done.
 *   - "bound to a different service" → confirm-overwrite prompt.
 */
export async function run(seed: SetupSeed): Promise<void> {
  const { print, prompt, cloudflare, state, flags } = seed
  const dryRun = flags.dryRun === true

  const current = await state.load()
  if (
    !current.account_id ||
    !current.web_hostname ||
    !current.web_worker_name ||
    !current.web_zone_id
  ) {
    throw new Error(
      "domain phase requires account_id, web_hostname, web_worker_name, and web_zone_id in state",
    )
  }

  if (dryRun) {
    print.muted(`[dry-run] would POST /accounts/${current.account_id}/workers/domains:`)
    print.muted(`[dry-run]   { hostname: '${current.web_hostname}',`)
    print.muted(`[dry-run]     service: '${current.web_worker_name}',`)
    print.muted(`[dry-run]     zone_id: '${current.web_zone_id}',`)
    print.muted(`[dry-run]     environment: 'production' }`)
    print.muted(`[dry-run]   → Cloudflare would auto-create the DNS record + provision a TLS cert`)
    return
  }

  const spinner = print.spin(`Binding ${current.web_hostname} to ${current.web_worker_name}...`)
  try {
    const result = await cloudflare.bindCustomDomain({
      accountId: current.account_id,
      hostname: current.web_hostname,
      serviceName: current.web_worker_name,
      zoneId: current.web_zone_id,
    })
    if (result.created) {
      // Brand-new binding — record it so rollback can unbind on failure.
      await state.recordCreated({ custom_domain: { hostname: current.web_hostname } })
      spinner.succeed(`Bound ${current.web_hostname} (CF is provisioning TLS)`)
      return
    }
    if (!result.conflictDifferentService) {
      // Same service already bound — pre-existing binding from a previous
      // successful run. Don't record for rollback (we didn't create it).
      spinner.succeed(`${current.web_hostname} is already bound to ${current.web_worker_name}`)
      return
    }
    // Different service is bound — ask the user before overwriting.
    spinner.warn(`${current.web_hostname} is currently bound to ${result.conflictDifferentService}`)
    const overwrite = await prompt.confirm({
      message: `Overwrite ${result.conflictDifferentService} with ${current.web_worker_name}?`,
      default: false,
    })
    if (!overwrite) {
      throw new Error(
        `Hostname ${current.web_hostname} is bound to ${result.conflictDifferentService}. ` +
          "Pick a different web_hostname or unbind the existing service manually, then re-run.",
      )
    }
    // Re-issue with overwrite intent. The CF API treats PUT as an upsert,
    // so calling bindCustomDomain again with the same hostname overwrites
    // any prior binding once the user has confirmed.
    const retrySpinner = print.spin(
      `Overwriting ${current.web_hostname} -> ${current.web_worker_name}...`,
    )
    try {
      await cloudflare.bindCustomDomain({
        accountId: current.account_id,
        hostname: current.web_hostname,
        serviceName: current.web_worker_name,
        zoneId: current.web_zone_id,
      })
      // Overwrite counts as "we own this binding now" — record for rollback
      // so we restore the state. Note: rollback unbinds completely, it does
      // NOT restore the previously-bound service. Document this in the
      // success card / README.
      await state.recordCreated({ custom_domain: { hostname: current.web_hostname } })
      retrySpinner.succeed(`Overwrote binding (CF is provisioning TLS)`)
    } catch (err) {
      retrySpinner.fail("Custom domain overwrite failed")
      throw err
    }
  } catch (err) {
    if (spinner.isSpinning) spinner.fail("Custom domain binding failed")
    throw err
  }
}
