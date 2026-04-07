import type { CreationManifest } from "../extensions/state"
import { CfError, WranglerError } from "./errors"
import type { SetupSeed } from "./steps/types"

/**
 * Result of a rollback / destroy walk.
 *
 * `deleted` is the human-readable list of resources successfully removed,
 * in the order the walk attempted them. `errors` is a parallel list of
 * resources whose delete operation failed — each entry has the resource
 * label plus the error message so the user can finish cleanup manually if
 * something goes wrong mid-walk.
 *
 * Walk functions never throw — they always return a result. Callers decide
 * whether the presence of any error is fatal.
 */
export interface RollbackResult {
  deleted: string[]
  errors: Array<{ resource: string; error: string }>
}

/**
 * Walk a manifest in REVERSE order and delete every resource it lists.
 *
 * Reverse order matters because:
 *   - The custom domain depends on the web worker existing
 *   - The web worker's service binding depends on the api worker existing
 *   - The api worker depends on the D1 + R2 bindings existing
 *
 * Each delete operation is best-effort and idempotent: if a resource is
 * already gone (404 from CF, "not found" from wrangler) it's treated as
 * success. If a delete fails for some other reason, we record the error
 * and continue with the next resource — never abort halfway through.
 *
 * This is the shared core for both rollback (failed-setup recovery) and
 * destroy (intentional teardown). The two callers differ only in how they
 * obtain the manifest:
 *   - rollback uses `state.created_by_wizard` (only what THIS run created)
 *   - destroy synthesizes one from the persisted state fields (everything)
 */
async function walkAndDelete(
  seed: SetupSeed,
  manifest: CreationManifest,
  zoneId: string | undefined,
  emailZoneLabel: string | undefined,
  accountId: string | undefined,
): Promise<RollbackResult> {
  const { cloudflare, wrangler } = seed
  const result: RollbackResult = { deleted: [], errors: [] }

  /**
   * Run a delete operation, recording success or failure into the result.
   * Catches everything — never lets a single resource's failure abort the
   * rest of the walk.
   */
  async function attempt(label: string, op: () => Promise<void>): Promise<void> {
    try {
      await op()
      result.deleted.push(label)
    } catch (err) {
      const message = formatError(err)
      result.errors.push({ resource: label, error: message })
    }
  }

  // 1. Custom domain (binds to web worker; must come off before web worker delete)
  if (manifest.custom_domain && accountId) {
    await attempt(`custom domain ${manifest.custom_domain.hostname}`, async () => {
      await cloudflare.unbindCustomDomain({
        accountId,
        hostname: (manifest.custom_domain as { hostname: string }).hostname,
      })
    })
  }

  // 2. Catch-all routing rule (points at the api worker)
  if (manifest.catch_all_rule_created && zoneId) {
    await attempt("catch-all routing rule", async () => {
      await cloudflare.deleteCatchAll(zoneId)
    })
  }

  // 3. Email Routing — only disable if WE enabled it
  if (manifest.email_routing_enabled_by_us && zoneId) {
    await attempt(`Email Routing on ${emailZoneLabel ?? zoneId}`, async () => {
      await cloudflare.disableEmailRouting(zoneId)
    })
  }

  // 4. Web worker (via CF REST API to bypass wrangler version drift)
  if (manifest.web_worker && accountId) {
    await attempt(`web worker ${manifest.web_worker}`, async () => {
      await cloudflare.deleteWorker({
        accountId,
        scriptName: manifest.web_worker as string,
      })
    })
  }

  // 5. API worker (via CF REST API to bypass wrangler version drift)
  if (manifest.api_worker && accountId) {
    await attempt(`api worker ${manifest.api_worker}`, async () => {
      await cloudflare.deleteWorker({
        accountId,
        scriptName: manifest.api_worker as string,
      })
    })
  }

  // 6. R2 bucket
  if (manifest.r2) {
    await attempt(`R2 bucket ${manifest.r2.name}`, async () => {
      await wrangler.r2Delete((manifest.r2 as { name: string }).name)
    })
  }

  // 7. D1 database
  if (manifest.d1) {
    await attempt(`D1 database ${manifest.d1.name}`, async () => {
      await wrangler.d1Delete((manifest.d1 as { name: string }).name)
    })
  }

  return result
}

/**
 * Roll back resources THIS wizard run created (post-failure cleanup).
 *
 * Reads `state.created_by_wizard` — anything not in there was either
 * pre-existing or never created and should not be touched. Used by the
 * setup command's catch handler when a phase fails partway through.
 *
 * Clears `created_by_wizard` at the end (even when some deletes failed)
 * so a re-run starts with a fresh manifest.
 */
export async function rollbackCreatedResources(seed: SetupSeed): Promise<RollbackResult> {
  const { state } = seed
  const current = await state.load()
  const manifest = current.created_by_wizard

  if (!manifest || Object.keys(manifest).length === 0) {
    // Nothing to roll back. Caller can decide whether to mention this.
    return { deleted: [], errors: [] }
  }

  const result = await walkAndDelete(
    seed,
    manifest,
    current.email_zone_id,
    current.email_zone,
    current.account_id,
  )

  // Clear the manifest so a re-run starts fresh. We do this even when some
  // deletes failed — the user can re-run rollback (or manually clean up
  // the failed resources) and we don't want stale entries.
  await state.save({ created_by_wizard: {} })

  return result
}

/**
 * Tear down an entire cloakmail deployment by synthesizing a manifest
 * from the persisted state fields and walking it.
 *
 * Unlike `rollbackCreatedResources` this is invoked AFTER a successful
 * setup, when the user wants to remove cloakmail from their account
 * entirely. We can't tell which resources we created vs adopted at this
 * point (the rollback manifest was cleared on success), so we delete
 * EVERYTHING the state file references — the user has explicitly opted
 * in via `cloakmail-cli destroy`.
 *
 * Note that `email_routing_enabled_by_us` is NOT included in the
 * synthesized manifest. Disabling Email Routing on a zone is the destroy
 * command's responsibility (it has its own opt-in prompt) so this walker
 * stays focused on resources cloakmail unambiguously owns.
 */
export async function destroyDeployment(seed: SetupSeed): Promise<RollbackResult> {
  const { state } = seed
  const current = await state.load()

  const manifest: CreationManifest = {}
  if (current.d1_name && current.d1_id) {
    manifest.d1 = { name: current.d1_name, uuid: current.d1_id }
  }
  if (current.r2_name) {
    manifest.r2 = { name: current.r2_name }
  }
  if (current.api_worker_name) {
    manifest.api_worker = current.api_worker_name
  }
  if (current.web_worker_name) {
    manifest.web_worker = current.web_worker_name
  }
  if (current.email_zone_id) {
    manifest.catch_all_rule_created = true
  }
  if (current.web_hostname) {
    manifest.custom_domain = { hostname: current.web_hostname }
  }

  return walkAndDelete(
    seed,
    manifest,
    current.email_zone_id,
    current.email_zone,
    current.account_id,
  )
}

/**
 * Pretty-print any error type the walk might encounter into a single
 * short string. Used to populate `RollbackResult.errors`.
 */
function formatError(err: unknown): string {
  if (err instanceof CfError) {
    const msgs = err.messages.length > 0 ? err.messages.join("; ") : "(no error messages)"
    return `Cloudflare API ${err.status}: ${msgs}`
  }
  if (err instanceof WranglerError) {
    // Wrangler stderr is noisy — it includes a "version out of date"
    // banner, ANSI control sequences, and the actual error somewhere in
    // the middle. We strip warnings, blank lines, and decorative chars,
    // then take the first remaining line that looks like an error.
    const errorLine =
      err.stderr
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .filter((line) => !/^▲\s*\[WARNING\]/i.test(line))
        .filter((line) => !/^Please update/i.test(line))
        .filter((line) => !/^Run `npm install/i.test(line))
        .filter((line) => !/^After installation/i.test(line))
        .filter((line) => !/^-+$/.test(line))
        .find((line) => /✘|\[ERROR\]|error/i.test(line)) ??
      err.stderr
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .find((line) => !/^▲|^Please update|^Run `|^After installation|^-+$/i.test(line)) ??
      "(no error output)"
    return `wrangler exit ${err.exitCode}: ${errorLine.slice(0, 200)}`
  }
  if (err instanceof Error) {
    return err.message
  }
  return String(err)
}
