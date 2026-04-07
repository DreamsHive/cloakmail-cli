import type { SetupSeed } from "./types"

/**
 * Phase 3 — Acquire the cloakmail source tree (plan step 10).
 *
 * Hands off to the `source` extension which knows how to:
 *  - resolve `--from <path>` against the local filesystem,
 *  - download + extract the GitHub tarball, OR
 *  - reuse a cached extraction under ~/.cloakmail-cli/cache/.
 *
 * The extension also runs the `.cli-manifest.json` compat check, so by the
 * time this step succeeds we know the templates and migrations live where
 * the next phases expect them to.
 */
export async function run(seed: SetupSeed): Promise<void> {
  const { print, source, state, flags } = seed

  const spinner = print.spin(
    flags.from
      ? `Using local cloakmail checkout at ${flags.from}...`
      : flags.version
        ? `Fetching cloakmail ${flags.version}...`
        : "Resolving + fetching latest cloakmail release...",
  )
  try {
    const acquired = await source.acquire({ from: flags.from, version: flags.version })
    spinner.succeed(`Acquired cloakmail ${acquired.version} at ${acquired.root}`)
    // Persist the version we used so the next run can detect upgrades and
    // future status / upgrade commands have a baseline to compare against.
    await state.save({ cloakmail_version: acquired.version })
  } catch (err) {
    spinner.fail("Source acquisition failed")
    throw err
  }
}
