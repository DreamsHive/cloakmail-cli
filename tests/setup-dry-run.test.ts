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
 * Dry-run end-to-end: walks all 9 phases with `--dry-run` set and asserts
 * that NO Cloudflare-mutating call was made (no wrangler deploys, no D1
 * creates, no CF API mutations, no HTTP probes), but the prompt flow and
 * template rendering still happened so the user can inspect the output.
 */
describe("setup command (dry-run, integration)", () => {
  test("walks all 9 phases without any CF mutation", async () => {
    const harness = buildFakeSeed({
      flags: { from: "/src", yes: true, dryRun: true },
      prompts: {
        passwords: ["any-fake-token"],
        inputs: ["example.com"],
        selects: ["example.com"],
        confirms: [false], // skip advanced settings
      },
      filesystem: {
        files: {
          "/src/packages/cloudflare/wrangler.toml.template": apiTemplate,
          "/src/packages/web/wrangler.toml.template": webTemplate,
        },
      },
      source: {
        acquire: async () => {
          harness.source.root = "/src"
          harness.source.manifest = fakeManifest
          return { root: "/src", manifest: fakeManifest, version: "v1.0.0-test" }
        },
      },
    })

    await steps.prompts(harness.seed)
    await steps.acquire(harness.seed)
    await steps.provision(harness.seed)
    await steps.render(harness.seed)
    await steps.deploy(harness.seed)
    await steps.routing(harness.seed)
    await steps.domain(harness.seed)
    await steps.verify(harness.seed)

    // -----------------------------------------------------------------
    // CRITICAL: zero Cloudflare mutations
    // -----------------------------------------------------------------
    expect(harness.wrangler.calls.deploys).toEqual([])
    expect(harness.wrangler.calls.d1Create).toEqual([])
    expect(harness.wrangler.calls.r2Create).toEqual([])
    expect(harness.wrangler.calls.migrate).toEqual([])
    expect(harness.cloudflare.calls.listZones).toEqual([])
    expect(harness.cloudflare.calls.enableEmailRouting).toEqual([])
    expect(harness.cloudflare.calls.upsertCatchAll).toEqual([])
    expect(harness.cloudflare.calls.bindCustomDomain).toEqual([])
    expect(harness.cloudflare.calls.pollMxVerified).toEqual([])

    // -----------------------------------------------------------------
    // Render still happens — useful for inspecting what would deploy
    // -----------------------------------------------------------------
    expect(harness.fs.writes["/src/packages/cloudflare/wrangler.toml"]).toContain(
      'name = "cloakmail-api-',
    )
    expect(harness.fs.writes["/src/packages/cloudflare/wrangler.toml"]).toContain(
      'database_id = "00000000-0000-0000-0000-000000000000"',
    )
    expect(harness.fs.writes["/src/packages/web/wrangler.toml"]).toContain('name = "cloakmail-web-')
    expect(harness.fs.writes["/src/packages/web/wrangler.toml"]).toContain(
      'PUBLIC_EMAIL_DOMAIN = "example.com"',
    )

    // -----------------------------------------------------------------
    // State reflects placeholders, not real IDs
    // -----------------------------------------------------------------
    const finalState = await harness.state.load()
    expect(finalState.email_zone).toBe("example.com")
    expect(finalState.web_hostname).toBe("example.com")
    expect(finalState.account_id).toBe("DRY-RUN-ACCOUNT-ID")
    expect(finalState.email_zone_id).toBe("DRY-RUN-EMAIL-ZONE-ID")
    expect(finalState.web_zone_id).toBe("DRY-RUN-WEB-ZONE-ID")
    expect(finalState.d1_id).toBe("00000000-0000-0000-0000-000000000000")
    // Dry-run does NOT mark phase 9 complete — re-running without dry-run
    // should still walk through everything fresh.
    expect(finalState.last_completed_phase).toBeUndefined()

    // -----------------------------------------------------------------
    // Final summary box has the dry-run title
    // -----------------------------------------------------------------
    const dryBox = harness.print.box.find((b) => b.title === "Dry run")
    expect(dryBox).toBeDefined()
    expect(dryBox?.text).toContain("DRY RUN COMPLETE")
    expect(dryBox?.text).toContain("No Cloudflare resources were created or modified.")

    // The "would deploy" hints should have been emitted via print.muted
    expect(harness.print.muted.some((m) => m.includes("[dry-run] would create D1"))).toBe(true)
    expect(
      harness.print.muted.some((m) => m.includes("[dry-run] would run: wrangler deploy")),
    ).toBe(true)
    expect(
      harness.print.muted.some((m) => m.includes("[dry-run] would PUT") && m.includes("catch_all")),
    ).toBe(true)
    expect(
      harness.print.muted.some(
        (m) => m.includes("[dry-run] would POST") && m.includes("/workers/domains"),
      ),
    ).toBe(true)
  })
})
