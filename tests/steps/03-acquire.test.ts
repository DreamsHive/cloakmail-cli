import { describe, expect, test } from "vitest"
import type { CloakmailManifest } from "../../src/extensions/source"
import { run as acquire } from "../../src/lib/steps/03-acquire"
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

describe("steps/03-acquire", () => {
  test("--from path: delegates to source.acquire and stores resolved version", async () => {
    const harness = buildFakeSeed({
      flags: { from: "/local/cloakmail" },
      source: {
        acquire: async (opts) => {
          expect(opts.from).toBe("/local/cloakmail")
          // Simulate `git describe --tags --always --dirty` returning a real
          // dev version string. This is what the resolved version looks like
          // when --from points at a git checkout 8 commits past v1.0.0.
          return {
            root: "/local/cloakmail",
            manifest: fakeManifest,
            version: "v1.0.0-8-gabc1234-dirty",
          }
        },
      },
    })
    await acquire(harness.seed)
    expect(harness.state.saves.at(-1)?.cloakmail_version).toBe("v1.0.0-8-gabc1234-dirty")
    expect(harness.print.spinners[0]?.events.some((e) => e.kind === "succeed")).toBe(true)
  })

  test("tarball path: passes through --version", async () => {
    let captured: { from?: string; version?: string } | undefined
    const harness = buildFakeSeed({
      flags: { version: "v1.2.3" },
      source: {
        acquire: async (opts) => {
          captured = opts
          return {
            root: "/cache/cloakmail-v1.2.3",
            manifest: fakeManifest,
            version: "v1.2.3",
          }
        },
      },
    })
    await acquire(harness.seed)
    expect(captured).toEqual({ from: undefined, version: "v1.2.3" })
    expect(harness.state.saves.at(-1)?.cloakmail_version).toBe("v1.2.3")
  })

  test("propagates AcquireError from manifest compat check", async () => {
    const harness = buildFakeSeed({
      flags: { from: "/local/cloakmail" },
      source: {
        acquire: async () => {
          throw new Error("min_cli_version mismatch")
        },
      },
    })
    await expect(acquire(harness.seed)).rejects.toThrow(/min_cli_version mismatch/)
    // Spinner should have failed (not succeeded).
    expect(harness.print.spinners[0]?.events.some((e) => e.kind === "fail")).toBe(true)
  })
})
