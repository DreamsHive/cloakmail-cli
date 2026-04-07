import type { SetupSeed } from "./types"

/**
 * Phase 4 — Provision Cloudflare resources (plan steps 11-12).
 *
 * D1 and R2 creation is delegated to the wrangler extension. We GET first,
 * create only on miss, so re-runs are no-ops. The captured D1 UUID is
 * persisted to state so the render phase can substitute it into the API
 * worker's wrangler.toml.
 */
export async function run(seed: SetupSeed): Promise<void> {
  const { print, wrangler, state, flags } = seed
  const dryRun = flags.dryRun === true

  const current = await state.load()
  const d1Name = current.d1_name
  const r2Name = current.r2_name
  if (!d1Name || !r2Name) {
    throw new Error(
      "Provision phase requires d1_name and r2_name in state. Run the prompts phase first.",
    )
  }

  if (dryRun) {
    // Skip wrangler calls entirely. We still write a placeholder D1 ID to
    // state so the render phase has something to substitute into the
    // wrangler.toml's database_id field — letting the user inspect what
    // the rendered file would actually look like.
    const placeholderD1Id = "00000000-0000-0000-0000-000000000000"
    print.muted(`[dry-run] would run: wrangler d1 list (detect or create ${d1Name})`)
    print.muted(`[dry-run] would create D1 ${d1Name} → captured database_id=${placeholderD1Id}`)
    print.muted(`[dry-run] would run: wrangler r2 bucket list (detect or create ${r2Name})`)
    print.muted(`[dry-run] would create R2 bucket ${r2Name}`)
    await state.save({ d1_id: placeholderD1Id })
    return
  }

  // -----------------------------------------------------------------
  // D1
  // -----------------------------------------------------------------
  const d1Spinner = print.spin(`Provisioning D1 database ${d1Name}...`)
  let d1Id = current.d1_id ?? ""
  try {
    const existing = await wrangler.d1List()
    const match = existing.find((db) => db.name === d1Name)
    if (match) {
      // Reused — DON'T record in created_by_wizard so rollback won't delete it.
      d1Id = match.uuid
      d1Spinner.succeed(`Reusing existing D1 ${d1Name} (${d1Id})`)
    } else {
      const created = await wrangler.d1Create(d1Name)
      d1Id = created.uuid
      // Record this creation IMMEDIATELY (before saving d1_id) so a crash
      // between create and the save below still leaves a rollback breadcrumb.
      await state.recordCreated({ d1: { name: d1Name, uuid: d1Id } })
      d1Spinner.succeed(`Created D1 ${d1Name} (${d1Id})`)
    }
    await state.save({ d1_id: d1Id })
  } catch (err) {
    d1Spinner.fail("D1 provisioning failed")
    throw err
  }

  // -----------------------------------------------------------------
  // R2
  // -----------------------------------------------------------------
  // We don't pre-list buckets because `wrangler r2 bucket list` dropped
  // its `--json` flag in 3.114, leaving only a brittle table format. The
  // wrangler.r2Create() method is idempotent — it tries to create the
  // bucket and returns { created: true|false } so we know whether to
  // record it for rollback.
  const r2Spinner = print.spin(`Provisioning R2 bucket ${r2Name}...`)
  try {
    const r2Result = await wrangler.r2Create(r2Name)
    if (r2Result.created) {
      await state.recordCreated({ r2: { name: r2Name } })
      r2Spinner.succeed(`Created R2 bucket ${r2Name}`)
    } else {
      // Reused existing bucket — don't record for rollback.
      r2Spinner.succeed(`Reusing existing R2 bucket ${r2Name}`)
    }
  } catch (err) {
    r2Spinner.fail("R2 provisioning failed")
    throw err
  }
}
