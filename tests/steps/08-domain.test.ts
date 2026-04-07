import { describe, expect, test } from "vitest"
import { run as domain } from "../../src/lib/steps/08-domain"
import { buildFakeSeed } from "../helpers/fake-seed"

const baseState = {
  account_id: "acct-1",
  web_hostname: "mail.example.com",
  web_worker_name: "cloakmail-web-test",
  web_zone_id: "zone-id-1",
}

describe("steps/08-domain", () => {
  test("201 Created path: succeeds without prompting", async () => {
    const harness = buildFakeSeed({
      state: baseState,
      cloudflare: {
        bindCustomDomain: async () => ({ created: true }),
      },
    })
    await domain(harness.seed)
    expect(harness.cloudflare.calls.bindCustomDomain).toHaveLength(1)
    expect(harness.print.spinners[0]?.events.some((e) => e.kind === "succeed")).toBe(true)
  })

  test("409 same service: skips without prompting", async () => {
    const harness = buildFakeSeed({
      state: baseState,
      cloudflare: {
        bindCustomDomain: async () => ({ created: false }),
      },
    })
    await domain(harness.seed)
    // Only one call — we don't retry / overwrite because it's the same service.
    expect(harness.cloudflare.calls.bindCustomDomain).toHaveLength(1)
  })

  test("409 different service: prompts to overwrite, retries on yes", async () => {
    let callIdx = 0
    const harness = buildFakeSeed({
      state: baseState,
      prompts: { confirms: [true] },
      cloudflare: {
        bindCustomDomain: async () => {
          callIdx++
          if (callIdx === 1) {
            return { created: false, conflictDifferentService: "other-worker" }
          }
          return { created: true }
        },
      },
    })
    await domain(harness.seed)
    // Two calls — initial conflict + the retry after confirmation.
    expect(harness.cloudflare.calls.bindCustomDomain).toHaveLength(2)
  })

  test("409 different service: throws on no", async () => {
    const harness = buildFakeSeed({
      state: baseState,
      prompts: { confirms: [false] },
      cloudflare: {
        bindCustomDomain: async () => ({
          created: false,
          conflictDifferentService: "other-worker",
        }),
      },
    })
    await expect(domain(harness.seed)).rejects.toThrow(/bound to other-worker/)
  })

  test("missing state values throws before any CF calls", async () => {
    const harness = buildFakeSeed({ state: {} })
    await expect(domain(harness.seed)).rejects.toThrow(/account_id/)
  })
})
