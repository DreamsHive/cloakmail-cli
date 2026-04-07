import { renderTemplate } from "../render"
import type { SetupSeed } from "./types"

/**
 * Phase 5 — Render the wrangler.toml templates (plan steps 13-14).
 *
 * Reads the templates the manifest declared, substitutes the user values
 * collected in the prompts phase, writes the rendered files into the
 * acquired source root (where the deploy phase will pick them up).
 *
 * The render is idempotent: re-runs overwrite the existing wrangler.toml
 * files in place. The templates themselves are committed in the cloakmail
 * repo and never touched.
 */
export async function run(seed: SetupSeed): Promise<void> {
  const { print, filesystem, source, state } = seed

  if (!source.root || !source.manifest) {
    throw new Error("render phase requires source.acquire() to have run first")
  }
  const current = await state.load()

  // Validate every variable up front so a missing field surfaces here
  // (with a clear error) rather than as a `{{PLACEHOLDER}}` left in the
  // generated wrangler.toml.
  const required: Record<string, string | undefined> = {
    api_worker_name: current.api_worker_name,
    web_worker_name: current.web_worker_name,
    d1_name: current.d1_name,
    d1_id: current.d1_id,
    r2_name: current.r2_name,
    email_zone: current.email_zone,
    email_ttl_seconds: current.email_ttl_seconds,
    max_email_size_mb: current.max_email_size_mb,
    app_name: current.app_name,
  }
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key)
  if (missing.length > 0) {
    throw new Error(
      `render phase missing state values: ${missing.join(", ")}. Did the prompts phase run?`,
    )
  }

  const apiVars: Record<string, string> = {
    API_WORKER_NAME: current.api_worker_name as string,
    D1_NAME: current.d1_name as string,
    D1_ID: current.d1_id as string,
    R2_NAME: current.r2_name as string,
    DOMAIN: current.email_zone as string,
    EMAIL_TTL_SECONDS: current.email_ttl_seconds as string,
    MAX_EMAIL_SIZE_MB: current.max_email_size_mb as string,
  }
  const webVars: Record<string, string> = {
    WEB_WORKER_NAME: current.web_worker_name as string,
    APP_NAME: current.app_name as string,
    DOMAIN: current.email_zone as string,
    API_WORKER_NAME: current.api_worker_name as string,
  }

  const apiTemplatePath = filesystem.path.join(
    source.root,
    source.manifest.templates.api_wrangler_toml,
  )
  const webTemplatePath = filesystem.path.join(
    source.root,
    source.manifest.templates.web_wrangler_toml,
  )

  // The rendered file lives next to the template — same dir, just stripping
  // `.template`. We do this so the wrangler invocation in the deploy phase
  // can simply `cd packages/cloudflare && wrangler deploy` without any
  // `--config <path>` ceremony.
  const apiOutPath = apiTemplatePath.replace(/\.template$/, "")
  const webOutPath = webTemplatePath.replace(/\.template$/, "")

  const apiSpinner = print.spin("Rendering API wrangler.toml...")
  try {
    const apiTemplate = await filesystem.read(apiTemplatePath)
    const apiRendered = renderTemplate(apiTemplate, apiVars)
    await filesystem.write(apiOutPath, apiRendered)
    apiSpinner.succeed(`Wrote ${apiOutPath}`)
  } catch (err) {
    apiSpinner.fail("API wrangler.toml render failed")
    throw err
  }

  const webSpinner = print.spin("Rendering web wrangler.toml...")
  try {
    const webTemplate = await filesystem.read(webTemplatePath)
    const webRendered = renderTemplate(webTemplate, webVars)
    await filesystem.write(webOutPath, webRendered)
    webSpinner.succeed(`Wrote ${webOutPath}`)
  } catch (err) {
    webSpinner.fail("Web wrangler.toml render failed")
    throw err
  }
}
