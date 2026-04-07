import { describe, expect, test } from "vitest"
import { run as routing } from "../../src/lib/steps/07-routing"
import { buildFakeSeed } from "../helpers/fake-seed"

const baseState = {
  email_zone_id: "zone-id-1",
  api_worker_name: "cloakmail-api-test",
}

describe("steps/07-routing", () => {
  test("happy path: routing already enabled, MX verified, catch-all upserted", async () => {
    const harness = buildFakeSeed({
      state: baseState,
      cloudflare: {
        getEmailRouting: async () => ({ enabled: true, status: "ready" }),
        pollMxVerified: async () => true,
      },
    })
    await routing(harness.seed)
    expect(harness.cloudflare.calls.upsertCatchAll).toEqual([
      { zoneId: "zone-id-1", workerName: "cloakmail-api-test" },
    ])
    // We did NOT call enableEmailRouting because it was already on.
    expect(harness.cloudflare.calls.enableEmailRouting).toHaveLength(0)
  })

  test("enables routing when getEmailRouting reports disabled", async () => {
    const harness = buildFakeSeed({
      state: baseState,
      cloudflare: {
        getEmailRouting: async () => ({ enabled: false, status: "pending" }),
        pollMxVerified: async () => true,
      },
    })
    await routing(harness.seed)
    expect(harness.cloudflare.calls.enableEmailRouting).toEqual(["zone-id-1"])
  })

  test("MX verification timeout throws with actionable message", async () => {
    const harness = buildFakeSeed({
      state: baseState,
      cloudflare: {
        getEmailRouting: async () => ({ enabled: true, status: "ready" }),
        pollMxVerified: async () => false,
      },
    })
    await expect(routing(harness.seed)).rejects.toThrow(/MX records did not verify/)
    // Catch-all should NOT have been called because we bailed out before then.
    expect(harness.cloudflare.calls.upsertCatchAll).toHaveLength(0)
  })

  test("missing state values throws before any CF calls", async () => {
    const harness = buildFakeSeed({ state: {} })
    await expect(routing(harness.seed)).rejects.toThrow(/email_zone_id/)
    expect(harness.cloudflare.calls.upsertCatchAll).toHaveLength(0)
  })
})
