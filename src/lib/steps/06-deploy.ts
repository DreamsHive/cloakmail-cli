import type { SetupSeed } from "./types"

/**
 * Phase 6 — Build and deploy both workers (plan steps 15-18).
 *
 *   1. Deploy API worker
 *   2. Apply D1 migrations
 *   3. Build the SvelteKit web app with ADAPTER=cloudflare
 *   4. Deploy web worker (its service binding now resolves to the API worker)
 *
 * The API worker MUST go first because the web worker's service binding
 * targets the API worker by name. Wrangler validates the binding at deploy
 * time and refuses to publish a worker whose binding points at a non-existent
 * service.
 */
export async function run(seed: SetupSeed): Promise<void> {
  const { print, wrangler, system, filesystem, source, state, flags } = seed
  const dryRun = flags.dryRun === true

  if (!source.root) {
    throw new Error("deploy phase requires source.acquire() to have run first")
  }
  const current = await state.load()
  if (!current.d1_name) {
    throw new Error("deploy phase requires d1_name in state")
  }

  if (dryRun) {
    const apiPath = filesystem.path.join(source.root, "packages", "cloudflare")
    const webPath = filesystem.path.join(source.root, "packages", "web")
    print.muted(`[dry-run] would run: wrangler deploy (cwd=${apiPath})`)
    print.muted(`[dry-run]   → API worker '${current.api_worker_name}' published to workers.dev`)
    print.muted(
      `[dry-run] would run: wrangler d1 migrations apply ${current.d1_name} --remote (cwd=${apiPath})`,
    )
    print.muted(`[dry-run]   → applies packages/cloudflare/migrations/0001_init.sql to D1`)
    print.muted(`[dry-run] would run: bun install (cwd=${webPath})`)
    print.muted(`[dry-run] would run: ADAPTER=cloudflare bun run build (cwd=${webPath})`)
    print.muted(`[dry-run]   → emits .svelte-kit/cloudflare/_worker.js`)
    print.muted(`[dry-run] would run: wrangler deploy (cwd=${webPath})`)
    print.muted(
      `[dry-run]   → web worker '${current.web_worker_name}' published, service binding to API resolves`,
    )
    return
  }

  // Step 15 — deploy API worker. wrangler picks up the rendered toml from
  // packages/cloudflare/wrangler.toml automatically because we cd into that
  // directory before invoking deploy.
  const apiSpinner = print.spin("Deploying API worker...")
  let apiUrl = ""
  try {
    const result = await wrangler.deploy("packages/cloudflare", { cwd: source.root })
    apiUrl = result.url
    if (current.api_worker_name) {
      await state.recordCreated({ api_worker: current.api_worker_name })
    }
    apiSpinner.succeed(`API worker deployed${apiUrl ? ` (${apiUrl})` : ""}`)
  } catch (err) {
    apiSpinner.fail("API worker deploy failed")
    throw err
  }

  // Step 16 — apply D1 migrations. Runs from the cloudflare package dir so
  // wrangler resolves the migrations dir relative to the rendered toml's
  // `migrations_dir = "migrations"` setting.
  const migrateSpinner = print.spin("Applying D1 migrations...")
  try {
    await wrangler.d1MigrationsApply(current.d1_name, {
      cwd: filesystem.path.join(source.root, "packages", "cloudflare"),
    })
    migrateSpinner.succeed("D1 migrations applied")
  } catch (err) {
    migrateSpinner.fail("D1 migrations failed")
    throw err
  }

  // Step 17 — build the SvelteKit app for Cloudflare. We run `bun install`
  // first so the web package's adapter-cloudflare devDep is present, then
  // `bun run build` with ADAPTER=cloudflare to pick the adapter override
  // baked into svelte.config.js.
  const webDir = filesystem.path.join(source.root, "packages", "web")
  const installSpinner = print.spin("Installing web package dependencies (bun install)...")
  try {
    const installResult = await system.exec("bun install", { cwd: webDir })
    if (installResult.exitCode !== 0) {
      throw new Error(installResult.stderr || "bun install exited non-zero")
    }
    installSpinner.succeed("Web dependencies installed")
  } catch (err) {
    installSpinner.fail("bun install failed in packages/web")
    throw err
  }

  const buildSpinner = print.spin("Building web app with ADAPTER=cloudflare...")
  try {
    const buildResult = await system.exec("bun run build", {
      cwd: webDir,
      env: {
        ...(process.env as Record<string, string>),
        ADAPTER: "cloudflare",
      },
    })
    if (buildResult.exitCode !== 0) {
      throw new Error(buildResult.stderr || "bun run build exited non-zero")
    }
    buildSpinner.succeed("Web app built")
  } catch (err) {
    buildSpinner.fail("Web app build failed")
    throw err
  }

  // Step 18 — deploy web worker. The service binding to the API worker
  // resolves now that the API worker is live (deployed in step 15).
  // We persist the workers.dev URL so the verify step can probe it
  // directly — bypasses the user's local DNS resolver lag for new custom
  // domains, which is the most common reason verify "fails" while the
  // browser-side test of the custom domain works fine.
  const webSpinner = print.spin("Deploying web worker...")
  try {
    const result = await wrangler.deploy("packages/web", { cwd: source.root })
    if (current.web_worker_name) {
      await state.recordCreated({ web_worker: current.web_worker_name })
    }
    if (result.url) {
      await state.save({ web_worker_url: result.url })
    }
    webSpinner.succeed(`Web worker deployed${result.url ? ` (${result.url})` : ""}`)
  } catch (err) {
    webSpinner.fail("Web worker deploy failed")
    throw err
  }
}
