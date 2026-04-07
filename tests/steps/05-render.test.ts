import { describe, expect, test } from "vitest"
import type { CloakmailManifest } from "../../src/extensions/source"
import { run as render } from "../../src/lib/steps/05-render"
import { buildFakeSeed } from "../helpers/fake-seed"

const fakeManifest: CloakmailManifest = {
  cloakmail_version: "1.0.0",
  min_cli_version: "0.1.0",
  templates: {
    api_wrangler_toml: "packages/cloudflare/wrangler.toml.template",
    web_wrangler_toml: "packages/web/wrangler.toml.template",
  },
  migrations: "packages/cloudflare/migrations",
  deployable_packages: ["packages/cloudflare", "packages/web"],
}

const apiTemplate = `name = "{{API_WORKER_NAME}}"
[[d1_databases]]
database_name = "{{D1_NAME}}"
database_id = "{{D1_ID}}"
[[r2_buckets]]
bucket_name = "{{R2_NAME}}"
[vars]
DOMAIN = "{{DOMAIN}}"
EMAIL_TTL_SECONDS = "{{EMAIL_TTL_SECONDS}}"
MAX_EMAIL_SIZE_MB = "{{MAX_EMAIL_SIZE_MB}}"
`

const webTemplate = `name = "{{WEB_WORKER_NAME}}"
[vars]
PUBLIC_APP_NAME = "{{APP_NAME}}"
PUBLIC_EMAIL_DOMAIN = "{{DOMAIN}}"
[[services]]
service = "{{API_WORKER_NAME}}"
`

const fullState = {
  api_worker_name: "cloakmail-api-test",
  web_worker_name: "cloakmail-web-test",
  d1_name: "cloakmail-db-test",
  d1_id: "uuid-1234",
  r2_name: "cloakmail-bodies-test",
  email_zone: "example.com",
  email_ttl_seconds: "86400",
  max_email_size_mb: "10",
  app_name: "CloakMail",
}

describe("steps/05-render", () => {
  test("substitutes every placeholder with the matching state value", async () => {
    const harness = buildFakeSeed({
      state: fullState,
      source: { root: "/src", manifest: fakeManifest },
      filesystem: {
        files: {
          "/src/packages/cloudflare/wrangler.toml.template": apiTemplate,
          "/src/packages/web/wrangler.toml.template": webTemplate,
        },
      },
    })
    await render(harness.seed)

    const renderedApi = harness.fs.writes["/src/packages/cloudflare/wrangler.toml"]
    expect(renderedApi).toContain('name = "cloakmail-api-test"')
    expect(renderedApi).toContain('database_name = "cloakmail-db-test"')
    expect(renderedApi).toContain('database_id = "uuid-1234"')
    expect(renderedApi).toContain('bucket_name = "cloakmail-bodies-test"')
    expect(renderedApi).toContain('DOMAIN = "example.com"')
    expect(renderedApi).toContain('EMAIL_TTL_SECONDS = "86400"')
    expect(renderedApi).toContain('MAX_EMAIL_SIZE_MB = "10"')
    expect(renderedApi).not.toContain("{{")

    const renderedWeb = harness.fs.writes["/src/packages/web/wrangler.toml"]
    expect(renderedWeb).toContain('name = "cloakmail-web-test"')
    expect(renderedWeb).toContain('PUBLIC_APP_NAME = "CloakMail"')
    expect(renderedWeb).toContain('PUBLIC_EMAIL_DOMAIN = "example.com"')
    expect(renderedWeb).toContain('service = "cloakmail-api-test"')
    expect(renderedWeb).not.toContain("{{")
  })

  test("missing state values trigger a clear error before reading templates", async () => {
    const harness = buildFakeSeed({
      state: { ...fullState, d1_id: undefined },
      source: { root: "/src", manifest: fakeManifest },
      filesystem: {
        files: {
          "/src/packages/cloudflare/wrangler.toml.template": apiTemplate,
          "/src/packages/web/wrangler.toml.template": webTemplate,
        },
      },
    })
    await expect(render(harness.seed)).rejects.toThrow(/d1_id/)
  })

  test("renderTemplate leaves unknown placeholders untouched", async () => {
    // Drop a stray {{UNKNOWN}} into the template to confirm it survives the
    // render. The contract says we never silently swallow placeholders.
    const harness = buildFakeSeed({
      state: fullState,
      source: { root: "/src", manifest: fakeManifest },
      filesystem: {
        files: {
          "/src/packages/cloudflare/wrangler.toml.template": `${apiTemplate}\nextra = "{{UNKNOWN}}"\n`,
          "/src/packages/web/wrangler.toml.template": webTemplate,
        },
      },
    })
    await render(harness.seed)
    const renderedApi = harness.fs.writes["/src/packages/cloudflare/wrangler.toml"]
    expect(renderedApi).toContain('extra = "{{UNKNOWN}}"')
  })
})
