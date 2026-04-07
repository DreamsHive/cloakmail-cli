import { describe, expect, test } from "vitest"
import type { CloakmailManifest } from "../src/extensions/source"
import * as steps from "../src/lib/steps/index"
import { buildFakeSeed } from "./helpers/fake-seed"

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

/**
 * End-to-end happy path through all 9 phases against the fake seed.
 *
 * The real `setup` command's `run` does exactly:
 *   await steps.validate(seed)
 *   await steps.prompts(seed)
 *   ... etc
 *
 * Calling the same sequence here gives us coverage of the wiring
 * (state flowing between steps, source becoming populated, deploys
 * happening in the right order) without dragging in the real CLI runtime
 * or any wrangler/CF calls.
 */
describe("setup command (happy path, integration)", () => {
  test("walks all 9 phases and writes the success state", async () => {
    const harness = buildFakeSeed({
      flags: { from: "/src", yes: true },
      prompts: {
        passwords: ["test-token"],
        inputs: ["example.com"],
        selects: ["example.com"],
        confirms: [false],
      },
      filesystem: {
        files: {
          "/src/packages/cloudflare/wrangler.toml.template": apiTemplate,
          "/src/packages/web/wrangler.toml.template": webTemplate,
        },
      },
      source: {
        acquire: async () => {
          // Mimic the real source extension by populating root + manifest
          // on the seed BEFORE the render phase tries to read them.
          harness.source.root = "/src"
          harness.source.manifest = fakeManifest
          return { root: "/src", manifest: fakeManifest, version: "v1.0.0-test" }
        },
      },
      cloudflare: {
        getEmailRouting: async () => ({ enabled: true, status: "ready" }),
        pollMxVerified: async () => true,
        bindCustomDomain: async () => ({ created: true }),
      },
    })

    // We have to skip phase 1 (validate) for the integration test because
    // it tries to actually call seed.system.which / seed.http.head — they're
    // stubbed in the fake seed, but we already have a dedicated unit test
    // for that step. Skipping here keeps this test focused on phases 2-9.
    await steps.prompts(harness.seed)
    await steps.acquire(harness.seed)
    await steps.provision(harness.seed)
    await steps.render(harness.seed)

    // Phase 6 (deploy) shells out to bun + wrangler, which the fake seed
    // doesn't pretend to model. Use the wrangler extension's spy and let
    // system.exec be a no-op (default in the fake seed). The integration
    // assertion is just "the wrangler.deploy method was invoked twice in
    // the right order".
    await steps.deploy(harness.seed)
    expect(harness.wrangler.calls.deploys).toEqual(["packages/cloudflare", "packages/web"])
    // d1MigrationsApply should have been called once with the generated D1 name.
    expect(harness.wrangler.calls.migrate).toHaveLength(1)
    expect(harness.wrangler.calls.migrate[0]).toMatch(/^cloakmail-/)
    // Provisioning should have created D1 and R2 (no existing resources).
    expect(harness.wrangler.calls.d1Create).toHaveLength(1)
    expect(harness.wrangler.calls.r2Create).toHaveLength(1)

    await steps.routing(harness.seed)
    await steps.domain(harness.seed)

    // Phase 9 (verify) probes /api/health and /. The fake seed's http.get
    // returns { status: 200, data: { status: "ok" } } by default which is
    // exactly what verify wants.
    await steps.verify(harness.seed)

    // Final state should reflect a complete, healthy run.
    const finalState = await harness.state.load()
    expect(finalState.last_completed_phase).toBe(9)
    expect(finalState.cloakmail_version).toBe("v1.0.0-test")
    expect(finalState.email_zone).toBe("example.com")
    expect(finalState.web_hostname).toBe("example.com")
    expect(finalState.d1_id).toBeTruthy()

    // Both wrangler.toml files should have been rendered into the source root.
    expect(harness.fs.writes["/src/packages/cloudflare/wrangler.toml"]).toContain('name = "')
    expect(harness.fs.writes["/src/packages/web/wrangler.toml"]).toContain('name = "')
    // CF API was called for the catch-all rule, custom domain, etc.
    expect(harness.cloudflare.calls.upsertCatchAll).toHaveLength(1)
    expect(harness.cloudflare.calls.bindCustomDomain).toHaveLength(1)

    // Final box was printed with the success card title (now uses an emoji).
    const successBox = harness.print.box.find((b) => b.title?.includes("Done"))
    expect(successBox).toBeDefined()
    expect(successBox?.text).toContain("CloakMail is live")
    expect(successBox?.text).toContain("example.com")
  })
})
