import { describe, expect, test } from "vitest"
import { run as prompts } from "../../src/lib/steps/02-prompts"
import { buildFakeSeed } from "../helpers/fake-seed"

describe("steps/02-prompts", () => {
  test("happy path: token, zone, hostname, no advanced settings, confirm", async () => {
    const harness = buildFakeSeed({
      flags: { yes: true },
      prompts: {
        passwords: ["test-token"],
        // Email zone
        inputs: ["example.com"],
        // Web hostname select picks the apex (default), then a confirm to
        // skip advanced settings, then nothing else needed because of --yes.
        selects: ["example.com"],
        confirms: [false /* show advanced? */],
      },
    })

    await prompts(harness.seed)

    // Token should have flowed into both extension setters.
    expect(harness.cloudflare.calls.setToken).toContain("test-token")
    // Zone lookup should have happened for the email zone and the web zone
    // (which collapses to the same zone since hostname is the apex).
    expect(harness.cloudflare.calls.listZones).toContain("example.com")
    // State should be persisted with all the essentials.
    const last = harness.state.saves.at(-1)
    expect(last).toMatchObject({
      email_zone: "example.com",
      web_hostname: "example.com",
      account_id: "acct-test",
    })
    // No --save-token, so api_token should be undefined in the persisted state.
    expect(last?.api_token).toBeUndefined()
  })

  test("re-prompts when the email zone is not in the account", async () => {
    let listCallCount = 0
    const harness = buildFakeSeed({
      flags: { yes: true },
      prompts: {
        passwords: ["test-token"],
        inputs: ["nope.example", "example.com"],
        selects: ["example.com"],
        confirms: [false],
      },
      cloudflare: {
        listZones: async (name) => {
          listCallCount++
          if (name === "nope.example") return []
          return [{ id: `${name}-id`, name, status: "active", accountId: "acct-test" }]
        },
      },
    })

    await prompts(harness.seed)

    // We should have called listZones at least twice — once for the bad zone,
    // once for the good one. The web hostname lookup also calls it for the
    // chosen apex domain, so the count is >= 2.
    expect(listCallCount).toBeGreaterThanOrEqual(2)
    expect(harness.state.saves.at(-1)?.email_zone).toBe("example.com")
  })

  test("advanced settings open custom worker / D1 / R2 names", async () => {
    const harness = buildFakeSeed({
      flags: { yes: true },
      prompts: {
        passwords: ["test-token"],
        // Order: email zone, then advanced inputs (api worker, web worker,
        // D1, R2, ttl, max size, app name).
        inputs: [
          "example.com",
          "api-custom",
          "web-custom",
          "db-custom",
          "bucket-custom",
          "3600",
          "5",
          "MyApp",
        ],
        selects: ["example.com"],
        confirms: [true /* show advanced */],
      },
    })

    await prompts(harness.seed)

    const last = harness.state.saves.at(-1)
    expect(last).toMatchObject({
      api_worker_name: "api-custom",
      web_worker_name: "web-custom",
      d1_name: "db-custom",
      r2_name: "bucket-custom",
      email_ttl_seconds: "3600",
      max_email_size_mb: "5",
      app_name: "MyApp",
    })
  })

  test("--save-token persists the token to state", async () => {
    const harness = buildFakeSeed({
      flags: { yes: true, saveToken: true },
      prompts: {
        passwords: ["secret-token-99"],
        inputs: ["example.com"],
        selects: ["example.com"],
        confirms: [false],
      },
    })
    await prompts(harness.seed)
    expect(harness.state.saves.at(-1)?.api_token).toBe("secret-token-99")
  })
})
