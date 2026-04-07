import { command, flag } from "@seedcli/core"
import { destroyDeployment } from "../lib/rollback"
import type { SetupSeed } from "../lib/steps/types"

/**
 * `cloakmail-cli destroy` — tear down an entire cloakmail deployment.
 *
 * Reads ~/.cloakmail-cli/state.json, displays every resource the wizard
 * deployed, prompts for explicit confirmation, then deletes them in
 * reverse-dependency order (custom domain → catch-all rule → workers →
 * R2 → D1). Each delete is idempotent — re-runs after a partial failure
 * are safe.
 *
 * Email Routing on the zone is preserved by default because it's a
 * one-time-per-zone setting that may be in use by something else; an
 * explicit prompt offers to disable it after the main teardown succeeds.
 *
 * Flags:
 *   --yes / -y          skip every confirmation (CI / scripted use)
 *   --keep-email-routing don't even ask about disabling Email Routing
 *   --keep-state         don't delete ~/.cloakmail-cli/state.json
 */
export default command({
  name: "destroy",
  description: "Tear down all cloakmail resources from your Cloudflare account",
  flags: {
    yes: flag({
      type: "boolean",
      alias: "y",
      description: "Skip every confirmation prompt (use with care)",
    }),
    keepEmailRouting: flag({
      type: "boolean",
      description: "Don't disable Email Routing on the zone (skip the prompt)",
    }),
    keepState: flag({
      type: "boolean",
      description: "Don't delete ~/.cloakmail-cli/state.json after teardown",
    }),
  },
  run: async (seed) => {
    // SetupSeed isn't a perfect match — the destroy command has its own
    // flags — but the rollback module uses these extension methods on it,
    // so we cast at the boundary. The cloudflare/wrangler/state extensions
    // attached to the seed are the same regardless of which command is
    // running.
    const setupSeed = seed as unknown as SetupSeed
    const { print, prompt, state, cloudflare, wrangler } = setupSeed
    const flags = seed.flags as { yes?: boolean; keepEmailRouting?: boolean; keepState?: boolean }

    const current = await state.load()

    // -----------------------------------------------------------------
    // Check there's actually a deployment in state to tear down
    // -----------------------------------------------------------------
    const hasAnything =
      current.api_worker_name ||
      current.web_worker_name ||
      current.d1_name ||
      current.r2_name ||
      current.web_hostname
    if (!hasAnything) {
      print.info("Nothing to destroy — state file is empty or missing.")
      print.muted(`State path: ${state.path}`)
      return
    }

    // -----------------------------------------------------------------
    // Show what's about to be deleted
    // -----------------------------------------------------------------
    print.newline()
    print.warning("This will permanently delete the following from your Cloudflare account:")
    print.newline()
    if (current.web_hostname) {
      print.muted(`  - Custom domain:      ${current.web_hostname}`)
    }
    if (current.email_zone_id && current.email_zone) {
      print.muted(`  - Catch-all rule:     on ${current.email_zone}`)
    }
    if (current.web_worker_name) {
      print.muted(`  - Web worker:         ${current.web_worker_name}`)
    }
    if (current.api_worker_name) {
      print.muted(`  - API worker:         ${current.api_worker_name}`)
    }
    if (current.r2_name) {
      print.muted(`  - R2 bucket:          ${current.r2_name}`)
    }
    if (current.d1_name) {
      print.muted(
        `  - D1 database:        ${current.d1_name}${current.d1_id ? ` (${current.d1_id})` : ""}`,
      )
    }
    print.newline()
    print.muted("Email Routing on the zone will NOT be disabled (separate prompt at the end).")
    print.newline()

    // -----------------------------------------------------------------
    // Get a token — required for both wrangler and the CF REST API
    // -----------------------------------------------------------------
    let token = current.api_token
    if (!token) {
      print.muted("Cloakmail-cli doesn't have a cached token. Paste your CF API token now")
      print.muted("(same scopes as the setup wizard required):")
      print.newline()
      token = await prompt.password({
        message: "Cloudflare API token",
        validate: (value) => value.length >= 8 || "Token looks too short",
      })
    }
    cloudflare.setToken(token)
    wrangler.setToken(token)
    if (current.account_id) {
      wrangler.setAccountId(current.account_id)
    }

    // -----------------------------------------------------------------
    // Final confirmation
    // -----------------------------------------------------------------
    if (!flags.yes) {
      const confirmed = await prompt.confirm({
        message: "Are you absolutely sure? This cannot be undone.",
        default: false,
      })
      if (!confirmed) {
        print.muted("Aborted. Nothing was deleted.")
        return
      }
    }

    // -----------------------------------------------------------------
    // Run the destroy walk
    // -----------------------------------------------------------------
    print.newline()
    const spinner = print.spin("Destroying cloakmail resources...")
    const result = await destroyDeployment(setupSeed)
    if (result.errors.length === 0) {
      spinner.succeed(`Deleted ${result.deleted.length} resource(s)`)
    } else {
      spinner.warn(
        `Deleted ${result.deleted.length} of ${result.deleted.length + result.errors.length}`,
      )
    }
    for (const item of result.deleted) {
      print.muted(`  ✓ ${item}`)
    }
    for (const failure of result.errors) {
      print.error(`  ✗ ${failure.resource}: ${failure.error}`)
    }

    // -----------------------------------------------------------------
    // Optionally disable Email Routing on the zone
    // -----------------------------------------------------------------
    if (!flags.keepEmailRouting && current.email_zone_id) {
      print.newline()
      let disable = flags.yes === true
      if (!flags.yes) {
        disable = await prompt.confirm({
          message: `Also disable Email Routing on ${current.email_zone}? (removes the auto-added MX records)`,
          default: false,
        })
      }
      if (disable) {
        const routingSpinner = print.spin(`Disabling Email Routing on ${current.email_zone}...`)
        try {
          await cloudflare.disableEmailRouting(current.email_zone_id)
          routingSpinner.succeed("Email Routing disabled")
        } catch (err) {
          routingSpinner.fail("Could not disable Email Routing")
          const reason = err instanceof Error ? err.message : String(err)
          print.muted(`  ${reason}`)
          print.muted(
            `  You can disable it manually at https://dash.cloudflare.com/?to=/:account/${current.email_zone}/email/routing`,
          )
        }
      } else {
        print.muted(`Email Routing on ${current.email_zone} left enabled.`)
      }
    }

    // -----------------------------------------------------------------
    // Clear the state file — ONLY on a fully clean teardown
    // -----------------------------------------------------------------
    // If any resource failed to delete, we leave the state file intact so
    // the user can re-run `destroy` to retry. Clearing it would orphan the
    // failed resources with no way for the wizard to find them again.
    const cleanRun = result.errors.length === 0
    if (cleanRun && !flags.keepState) {
      await state.clear()
      print.muted(`State file cleared (${state.path})`)
    } else if (!cleanRun) {
      print.muted(`State file kept (${state.path}) — re-run \`cloakmail-cli destroy\` to retry.`)
    } else {
      print.muted(`State file kept (${state.path}) — pass --reset to setup if you re-run.`)
    }

    print.newline()
    if (cleanRun) {
      print.success("Done. Cloakmail has been removed from your Cloudflare account.")
    } else {
      print.warning(
        `Done with ${result.errors.length} error(s). Re-run \`cloakmail-cli destroy\` ` +
          "after fixing the underlying issue, or clean up manually in the dashboard.",
      )
    }
  },
})
