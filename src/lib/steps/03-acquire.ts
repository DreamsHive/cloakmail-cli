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
 * time this function returns we know the templates and migrations live where
 * the next phases expect them to.
 *
 * IMPORTANT: this step does NOT create its own spinner. All visual feedback
 * (lookup / download / extract / success / failure) is owned by the `source`
 * extension so that only one spinner is ever active at a time. A previous
 * version of this file wrapped `source.acquire()` in an outer spinner, which
 * caused ora's "Multiple concurrent spinners detected" warning to fire when
 * the inner lookup spinner started — we now let the extension handle the
 * entire visual lifecycle itself.
 */
export async function run(seed: SetupSeed): Promise<void> {
  const { source, state, flags } = seed

  const acquired = await source.acquire({ from: flags.from, version: flags.version })
  // Persist the version we used so the next run can detect upgrades and
  // future status / upgrade commands have a baseline to compare against.
  await state.save({ cloakmail_version: acquired.version })
}
