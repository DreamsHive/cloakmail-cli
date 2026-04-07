import { command, flag } from "@seedcli/core"
import { AcquireError, CfError, WranglerError } from "../lib/errors"
import { rollbackCreatedResources } from "../lib/rollback"
import * as steps from "../lib/steps/index"
import type { SetupSeed } from "../lib/steps/types"

/**
 * Render a fatal error from any phase as an actionable remediation hint.
 *
 * Each error class carries its own context (CF status code, wrangler stderr,
 * etc.) so we don't lose detail when collapsing the pipeline into a single
 * error message at the top of the command.
 */
function handleError(seed: SetupSeed, err: unknown): void {
  const { print } = seed
  print.newline()
  if (err instanceof CfError) {
    print.error(`Cloudflare API error (${err.status}): ${err.messages.join("; ")}`)
    if (err.hint) print.muted(err.hint)
    return
  }
  if (err instanceof WranglerError) {
    print.error(`wrangler ${err.command} failed (exit ${err.exitCode})`)
    print.muted(err.stderr)
    return
  }
  if (err instanceof AcquireError) {
    print.error(`Source acquisition failed: ${err.reason}`)
    if (err.version) print.muted(`Version: ${err.version}`)
    return
  }
  if (err instanceof Error) {
    print.error(err.message)
  } else {
    print.error(String(err))
  }
}

export default command({
  name: "setup",
  description: "Deploy cloakmail to your Cloudflare account end-to-end",
  flags: {
    from: flag({
      type: "string",
      description: "Use a local cloakmail checkout instead of fetching from GitHub",
    }),
    version: flag({
      type: "string",
      description: "Pin to a specific cloakmail release tag (default: latest)",
    }),
    reset: flag({
      type: "boolean",
      description: "Ignore cached state in ~/.cloakmail-cli/state.json and prompt fresh",
    }),
    saveToken: flag({
      type: "boolean",
      description:
        "Cache the CF API token to ~/.cloakmail-cli/state.json (default: in-memory only)",
    }),
    yes: flag({
      type: "boolean",
      alias: "y",
      description: "Skip the final confirmation prompt (for CI / scripts)",
    }),
    dryRun: flag({
      type: "boolean",
      description:
        "Walk through prompts and render templates without touching Cloudflare. No real changes are made.",
    }),
    noRollback: flag({
      type: "boolean",
      description:
        "Skip the rollback prompt on error. Resources created so far stay in your CF account for manual cleanup or debugging.",
    }),
  },
  run: async (seed) => {
    if (seed.flags.dryRun) {
      seed.print.warning("DRY RUN MODE — no Cloudflare resources will be created or modified.")
      seed.print.newline()
    }
    try {
      // Phase 1 — Validate prereqs (wrangler binary, network, state file)
      await steps.validate(seed)
      // Phase 2 — Collect every input + persist to ~/.cloakmail-cli/state.json
      await steps.prompts(seed)
      // Phase 3 — Acquire the cloakmail source tree (--from or tarball)
      await steps.acquire(seed)
      // Phase 4 — Provision D1 + R2 via wrangler
      await steps.provision(seed)
      // Phase 5 — Render wrangler.toml templates inside the source root
      await steps.render(seed)
      // Phase 6 — Build + deploy both workers, run D1 migrations
      await steps.deploy(seed)
      // Phase 7 — Email Routing: enable, MX poll, catch-all upsert
      await steps.routing(seed)
      // Phase 8 — Bind Workers Custom Domain (with 409 conflict handling)
      await steps.domain(seed)
      // Phase 9 — Health probe, site probe, success card
      await steps.verify(seed)
    } catch (err) {
      handleError(seed, err)
      // Dry-run never creates anything → nothing to roll back.
      if (seed.flags.dryRun) {
        process.exit(1)
      }
      await maybeRollback(seed)
      process.exit(1)
    }
  },
})

/**
 * Offer to roll back any resources the failed run created. Skipped entirely
 * when --no-rollback is set OR when the rollback manifest is empty (the
 * failure happened before any resource was created).
 *
 * Walks the manifest in reverse order — see src/lib/rollback.ts for the
 * exact ordering and idempotency rules.
 */
async function maybeRollback(seed: SetupSeed): Promise<void> {
  const { print, prompt, state, flags } = seed

  const current = await state.load()
  const manifest = current.created_by_wizard ?? {}
  const hasResources = Object.keys(manifest).some((k) => {
    const value = (manifest as Record<string, unknown>)[k]
    return value !== undefined && value !== false && value !== null
  })

  if (!hasResources) {
    // Nothing was created yet (failure happened in validate / prompts /
    // acquire / render). Just exit cleanly.
    return
  }

  print.newline()
  print.warning("Some resources were created in your Cloudflare account before the failure:")
  if (manifest.d1) print.muted(`  - D1 database:        ${manifest.d1.name} (${manifest.d1.uuid})`)
  if (manifest.r2) print.muted(`  - R2 bucket:          ${manifest.r2.name}`)
  if (manifest.api_worker) print.muted(`  - API worker:         ${manifest.api_worker}`)
  if (manifest.web_worker) print.muted(`  - Web worker:         ${manifest.web_worker}`)
  if (manifest.email_routing_enabled_by_us)
    print.muted(`  - Email Routing:      enabled on ${current.email_zone}`)
  if (manifest.catch_all_rule_created)
    print.muted(`  - Catch-all rule:     on ${current.email_zone}`)
  if (manifest.custom_domain)
    print.muted(`  - Custom domain:      ${manifest.custom_domain.hostname}`)
  print.newline()

  if (flags.noRollback) {
    print.muted("Skipping rollback (--no-rollback was set). Clean up manually if needed.")
    return
  }

  let shouldRollback = true
  if (!flags.yes) {
    shouldRollback = await prompt.confirm({
      message: "Roll back these resources now?",
      default: true,
    })
  }
  if (!shouldRollback) {
    print.muted("Skipping rollback. Re-run cloakmail-cli setup to retry from where it failed.")
    return
  }

  print.newline()
  const spinner = print.spin("Rolling back resources...")
  const result = await rollbackCreatedResources(seed)
  if (result.errors.length === 0) {
    spinner.succeed(`Rolled back ${result.deleted.length} resource(s)`)
  } else {
    spinner.warn(
      `Rolled back ${result.deleted.length} of ${result.deleted.length + result.errors.length}`,
    )
  }
  for (const item of result.deleted) {
    print.muted(`  ✓ deleted ${item}`)
  }
  for (const failure of result.errors) {
    print.error(`  ✗ ${failure.resource}: ${failure.error}`)
  }
  if (result.errors.length > 0) {
    print.newline()
    print.muted(
      "Some resources could not be deleted automatically. Clean them up manually in the Cloudflare dashboard.",
    )
  }
}
