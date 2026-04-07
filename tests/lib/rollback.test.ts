import { describe, expect, test } from "vitest"
import { CfError, WranglerError } from "../../src/lib/errors"
import { rollbackCreatedResources } from "../../src/lib/rollback"
import { buildFakeSeed } from "../helpers/fake-seed"

/**
 * Tests for the rollback walker. We exercise it directly against the fake
 * seed harness rather than going through the setup command — that way each
 * scenario is a tiny self-contained state shape, no prompt mocking needed.
 */
describe("rollback", () => {
  test("no-op when manifest is empty", async () => {
    const harness = buildFakeSeed({
      state: { account_id: "acct-1", email_zone_id: "zone-1" },
    })
    const result = await rollbackCreatedResources(harness.seed)
    expect(result.deleted).toEqual([])
    expect(result.errors).toEqual([])
    // Nothing was called.
    expect(harness.cloudflare.calls.deleteWorker).toEqual([])
    expect(harness.wrangler.calls.d1Delete).toEqual([])
    expect(harness.wrangler.calls.r2Delete).toEqual([])
    expect(harness.cloudflare.calls.unbindCustomDomain).toEqual([])
    expect(harness.cloudflare.calls.deleteCatchAll).toEqual([])
    expect(harness.cloudflare.calls.disableEmailRouting).toEqual([])
  })

  test("full rollback walks resources in reverse order", async () => {
    const harness = buildFakeSeed({
      state: {
        account_id: "acct-1",
        email_zone: "example.com",
        email_zone_id: "zone-1",
        web_hostname: "temp.example.com",
        created_by_wizard: {
          d1: { name: "cloakmail-d1", uuid: "d1-uuid" },
          r2: { name: "cloakmail-r2" },
          api_worker: "cloakmail-api-x",
          web_worker: "cloakmail-web-x",
          email_routing_enabled_by_us: true,
          catch_all_rule_created: true,
          custom_domain: { hostname: "temp.example.com" },
        },
      },
    })

    const result = await rollbackCreatedResources(harness.seed)
    expect(result.errors).toEqual([])
    // Reverse order: domain → catch-all → routing → web → api → R2 → D1
    expect(result.deleted).toEqual([
      "custom domain temp.example.com",
      "catch-all routing rule",
      "Email Routing on example.com",
      "web worker cloakmail-web-x",
      "api worker cloakmail-api-x",
      "R2 bucket cloakmail-r2",
      "D1 database cloakmail-d1",
    ])

    // Each delete operation was actually invoked.
    expect(harness.cloudflare.calls.unbindCustomDomain).toHaveLength(1)
    expect(harness.cloudflare.calls.deleteCatchAll).toEqual(["zone-1"])
    expect(harness.cloudflare.calls.disableEmailRouting).toEqual(["zone-1"])
    expect(harness.cloudflare.calls.deleteWorker.map((c) => c.scriptName)).toEqual([
      "cloakmail-web-x",
      "cloakmail-api-x",
    ])
    expect(harness.wrangler.calls.r2Delete).toEqual(["cloakmail-r2"])
    expect(harness.wrangler.calls.d1Delete).toEqual(["cloakmail-d1"])

    // Manifest is cleared after rollback.
    const after = await harness.state.load()
    expect(after.created_by_wizard).toEqual({})
  })

  test("partial rollback only touches recorded resources", async () => {
    // Failure happened at provision after creating D1 but before R2.
    const harness = buildFakeSeed({
      state: {
        account_id: "acct-1",
        email_zone_id: "zone-1",
        created_by_wizard: {
          d1: { name: "cloakmail-d1", uuid: "d1-uuid" },
        },
      },
    })

    const result = await rollbackCreatedResources(harness.seed)
    expect(result.errors).toEqual([])
    expect(result.deleted).toEqual(["D1 database cloakmail-d1"])
    expect(harness.wrangler.calls.d1Delete).toEqual(["cloakmail-d1"])
    // R2 / workers / domain / routing all skipped.
    expect(harness.wrangler.calls.r2Delete).toEqual([])
    expect(harness.cloudflare.calls.deleteWorker).toEqual([])
    expect(harness.cloudflare.calls.unbindCustomDomain).toEqual([])
  })

  test("does not disable email routing if WE didn't enable it", async () => {
    // catch_all_rule_created is true (we configured it) but
    // email_routing_enabled_by_us is FALSE — routing was already on before
    // our run, so we must NOT disable it on rollback.
    const harness = buildFakeSeed({
      state: {
        account_id: "acct-1",
        email_zone: "example.com",
        email_zone_id: "zone-1",
        created_by_wizard: {
          catch_all_rule_created: true,
          // email_routing_enabled_by_us deliberately omitted
        },
      },
    })

    const result = await rollbackCreatedResources(harness.seed)
    expect(result.errors).toEqual([])
    expect(result.deleted).toEqual(["catch-all routing rule"])
    // Catch-all was disabled, but Email Routing itself was NOT touched.
    expect(harness.cloudflare.calls.deleteCatchAll).toEqual(["zone-1"])
    expect(harness.cloudflare.calls.disableEmailRouting).toEqual([])
  })

  test("continues after a single delete failure and reports it", async () => {
    // Worker delete (via CF API now) fails, but D1 + R2 deletes should still run.
    const harness = buildFakeSeed({
      state: {
        account_id: "acct-1",
        created_by_wizard: {
          d1: { name: "cloakmail-d1", uuid: "d1-uuid" },
          r2: { name: "cloakmail-r2" },
          api_worker: "cloakmail-api-x",
        },
      },
      cloudflare: {
        deleteWorker: async () => {
          throw new CfError(500, ["Internal server error"], "check CF status")
        },
      },
    })

    const result = await rollbackCreatedResources(harness.seed)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.resource).toBe("api worker cloakmail-api-x")
    expect(result.errors[0]?.error).toContain("Cloudflare API 500")
    // D1 and R2 still deleted despite the worker failure.
    expect(result.deleted).toEqual(["R2 bucket cloakmail-r2", "D1 database cloakmail-d1"])
  })

  test("handles CfError during rollback gracefully", async () => {
    const harness = buildFakeSeed({
      state: {
        account_id: "acct-1",
        email_zone_id: "zone-1",
        created_by_wizard: {
          catch_all_rule_created: true,
        },
      },
      cloudflare: {
        deleteCatchAll: async () => {
          throw new CfError(403, ["Forbidden"], "check token scopes")
        },
      },
    })

    const result = await rollbackCreatedResources(harness.seed)
    expect(result.deleted).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.error).toContain("Cloudflare API 403")
  })

  test("manifest is cleared even when deletes fail", async () => {
    // Re-run after partial rollback failure should NOT try to delete the
    // same resources again. Clearing the manifest is the contract.
    const harness = buildFakeSeed({
      state: {
        account_id: "acct-1",
        created_by_wizard: {
          d1: { name: "cloakmail-d1", uuid: "d1-uuid" },
        },
      },
      wrangler: {
        d1Delete: async () => {
          throw new WranglerError(1, "boom", "d1 delete cloakmail-d1")
        },
      },
    })

    await rollbackCreatedResources(harness.seed)
    const after = await harness.state.load()
    expect(after.created_by_wizard).toEqual({})
  })
})
