import type { Seed } from "@seedcli/core"

/**
 * Shape of the `setup` command's flags. Centralized here so the step files
 * can take a single concrete `SetupSeed` instead of either `Seed` (which
 * would lose flag types) or each redeclaring the flag interface.
 *
 * Keep in sync with `src/commands/setup.ts`.
 */
export interface SetupFlags {
  from?: string
  version?: string
  reset?: boolean
  saveToken?: boolean
  yes?: boolean
  dryRun?: boolean
  noRollback?: boolean
}

/**
 * Per-step seed alias.
 *
 * The seedcli `Seed` type's `args` parameter defaults to `Record<string,
 * never>`, but the runtime instance ends up with `Record<string, string |
 * undefined>` because the parser doesn't know the command takes no args.
 * We use `Record<string, unknown>` here so the assignment from the
 * command's run callback parameter to a `SetupSeed` succeeds without
 * casting.
 */
export type SetupSeed = Seed<Record<string, unknown>, SetupFlags>
