import { describe, expect, test } from "vitest"
import { run as validate } from "../../src/lib/steps/01-validate"
import { buildFakeSeed } from "../helpers/fake-seed"

describe("steps/01-validate", () => {
  test("succeeds when wrangler is on PATH and CF API is reachable", async () => {
    const harness = buildFakeSeed({
      systemWhich: () => "/usr/local/bin/wrangler",
      http: { get: async () => ({ status: 200, data: { ipv4_cidrs: [] } }) },
    })
    await validate(harness.seed)
    // Three spinners (wrangler, network, state) — every one should have
    // succeeded so the step exits cleanly.
    expect(harness.print.spinners).toHaveLength(3)
    for (const sp of harness.print.spinners) {
      expect(sp.events.some((e) => e.kind === "succeed")).toBe(true)
    }
  })

  test("warns but does not throw when wrangler is missing from PATH", async () => {
    const harness = buildFakeSeed({
      systemWhich: () => undefined,
      http: { get: async () => ({ status: 200, data: { ipv4_cidrs: [] } }) },
    })
    // wrangler is bundled as a dep, so a missing PATH lookup is a soft warn,
    // not a hard fail — the wrangler extension's node_modules walk handles it.
    await validate(harness.seed)
    const wranglerSpinner = harness.print.spinners[0]
    expect(wranglerSpinner?.events.some((e) => e.kind === "warn")).toBe(true)
  })

  test("throws when CF API is unreachable (real network failure)", async () => {
    const harness = buildFakeSeed({
      systemWhich: () => "/usr/local/bin/wrangler",
      http: {
        get: async () => {
          // Plain Error with no `status` field — simulates DNS / connection
          // refused. This is what the validate step now treats as a real
          // network failure.
          throw new Error("getaddrinfo ENOTFOUND api.cloudflare.com")
        },
      },
    })
    await expect(validate(harness.seed)).rejects.toThrow(/Network check failed/)
  })

  test("succeeds when CF returns an HTTP error status (server is reachable)", async () => {
    // When seed.http.get throws with a `status` field (HttpError), the server
    // is reachable — we just got a non-2xx response. Validate should treat
    // this as success, not failure. This is the regression that bit us when
    // /client/v4/ root returned 400 Bad Request.
    const harness = buildFakeSeed({
      systemWhich: () => "/usr/local/bin/wrangler",
      http: {
        get: async () => {
          const err = new Error("HTTP 400") as Error & { status: number }
          err.status = 400
          throw err
        },
      },
    })
    await validate(harness.seed)
    const netSpinner = harness.print.spinners[1]
    expect(netSpinner?.events.some((e) => e.kind === "succeed")).toBe(true)
  })
})
