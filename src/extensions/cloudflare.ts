import { defineExtension } from "@seedcli/core"
import type { HttpClient, HttpResponse } from "@seedcli/http"
import { CfError } from "../lib/errors"

/**
 * Common envelope for v4 Cloudflare API responses.
 *
 * Every endpoint returns `{ success, errors, messages, result }`. We unwrap
 * `result` for callers and surface `errors` via `CfError` on failures.
 */
interface CfEnvelope<T> {
  success: boolean
  errors: Array<{ code: number; message: string }>
  messages: Array<{ code: number; message: string }>
  result: T
}

interface CfZone {
  id: string
  name: string
  status: string
  account: { id: string; name: string }
}

interface CfTokenVerifyResult {
  id: string
  status: string
}

interface CfEmailRoutingSettings {
  enabled: boolean
  status: string
  name?: string
}

interface CfEmailRoutingDnsRecord {
  type: string
  name: string
  content: string
  priority?: number
}

interface CfEmailRoutingDnsResult {
  errors: string[]
  records: CfEmailRoutingDnsRecord[]
  // Cloudflare currently doesn't return a single boolean — callers infer
  // verification by checking that `errors` is empty. We expose the raw shape
  // here so steps can render hints if a record is missing.
}

interface CfEmailRoutingRule {
  tag?: string
  name?: string
  enabled?: boolean
  priority?: number
  matchers: Array<{ type: string; field?: string; value?: string }>
  actions: Array<{ type: string; value: string[] }>
}

interface CfWorkerDomain {
  id: string
  zone_id: string
  zone_name: string
  hostname: string
  service: string
  environment: string
}

/**
 * Result of `checkAccountPrereqs(accountId)`.
 *
 * Each field reports the status of one one-time-per-account Cloudflare
 * setting that the wizard depends on. Missing prerequisites are surfaced
 * as actionable errors BEFORE any resources are created, so the user
 * doesn't end up with an orphan D1/R2 in their account that the rollback
 * step has to clean up after.
 */
export interface AccountPrereqs {
  /**
   * The user's workers.dev subdomain (e.g. "devoresyah") if registered,
   * `null` if they haven't picked one yet. Required to deploy any worker
   * to *.workers.dev.
   */
  workersSubdomain: string | null
  /** Whether R2 has been enabled on this account (R2 is opt-in due to ToS). */
  r2Enabled: boolean
}

declare module "@seedcli/core" {
  interface SeedExtensions {
    cloudflare: {
      /** Set the bearer token used for every Cloudflare REST request. */
      setToken(token: string): void
      /**
       * Returns the verified token's status plus the account_id from
       * `/user/tokens/verify`. The verify endpoint itself doesn't return
       * an account id — we extract one via a follow-up `/accounts` call.
       */
      verifyToken(): Promise<{ accountId: string; status: string }>
      /**
       * One-shot check for account-level Cloudflare prerequisites that
       * can't be auto-fixed from the CLI: workers.dev subdomain registration
       * and R2 enablement. Both are one-time-per-account settings the user
       * must complete in the dashboard. Called from the prompts step right
       * after token verify so missing prereqs surface BEFORE any resource
       * is created.
       */
      checkAccountPrereqs(accountId: string): Promise<AccountPrereqs>
      /** List zones matching `name` (exact match used by callers). */
      listZones(
        name: string,
      ): Promise<Array<{ id: string; name: string; status: string; accountId: string }>>
      /** Enable Email Routing on a zone (POST .../email/routing/enable). */
      enableEmailRouting(zoneId: string): Promise<void>
      /** Read current Email Routing settings for a zone. */
      getEmailRouting(zoneId: string): Promise<{ enabled: boolean; status: string }>
      /**
       * Polls `/zones/{id}/email/routing/dns` until the response reports no
       * outstanding errors (or the timeout fires). Returns true on success,
       * false on timeout — callers print the missing MX records on false.
       */
      pollMxVerified(zoneId: string, timeoutMs?: number): Promise<boolean>
      /**
       * GETs the catch-all rule and either PUTs an update or POSTs a fresh
       * rule pointing at `workerName`. Idempotent across re-runs.
       */
      upsertCatchAll(zoneId: string, workerName: string): Promise<void>
      /**
       * Bind a Workers Custom Domain. On 409, distinguishes between
       * "already bound to this exact service" (skip) and "bound to a
       * different service" (returned via `conflictDifferentService`).
       */
      bindCustomDomain(opts: {
        accountId: string
        hostname: string
        serviceName: string
        zoneId: string
      }): Promise<{ created: boolean; conflictDifferentService?: string }>
      /**
       * Idempotent custom domain unbind. Looks up the domain by hostname,
       * deletes it. 404 means already gone — treated as success.
       * Used by the rollback step.
       */
      unbindCustomDomain(opts: { accountId: string; hostname: string }): Promise<void>
      /**
       * Idempotent catch-all rule delete. We disable the rule rather than
       * delete because Cloudflare's API requires a catch-all rule to exist
       * once Email Routing is enabled — it can be disabled but not removed.
       * Used by the rollback step.
       */
      deleteCatchAll(zoneId: string): Promise<void>
      /**
       * Idempotent disable Email Routing on a zone. Used by the rollback
       * step IF the wizard's run was the one that enabled it. Skipped if
       * Email Routing was already on before the wizard started.
       */
      disableEmailRouting(zoneId: string): Promise<void>
      /**
       * Idempotent worker delete via the CF REST API.
       * `DELETE /accounts/{id}/workers/scripts/{name}`. Used by rollback /
       * destroy. Avoids the wrangler version-drift bugs around the
       * `wrangler delete` command's flags and interactive confirmation.
       */
      deleteWorker(opts: { accountId: string; scriptName: string }): Promise<void>
      /** The underlying typed http client for ad-hoc requests. */
      api: HttpClient
    }
  }
}

/**
 * Extract the array of error messages out of a CfEnvelope (or any unknown
 * Cloudflare error body) so we can build a useful CfError without crashing
 * on unexpected response shapes.
 *
 * Cloudflare's error objects have shape `{ code: number, message: string }`.
 * We include both in the rendered string so the user gets a CF error code
 * (e.g. `9109`, `9106`, `10042`) they can search for. The bare message
 * field alone is often too vague ("Authentication error").
 */
function extractErrors(body: unknown): string[] {
  if (body && typeof body === "object" && "errors" in body) {
    const errors = (body as { errors: unknown }).errors
    if (Array.isArray(errors)) {
      return errors
        .map((entry) => {
          if (entry && typeof entry === "object") {
            const e = entry as { code?: unknown; message?: unknown }
            const message = e.message ? String(e.message) : ""
            const code = e.code ? `[${e.code}]` : ""
            return [code, message].filter(Boolean).join(" ").trim()
          }
          return JSON.stringify(entry)
        })
        .filter(Boolean)
    }
  }
  return []
}

export default defineExtension({
  name: "cloudflare",
  description: "Typed Cloudflare REST API client",

  setup: (seed) => {
    const { http } = seed

    // The client is created lazily inside setToken so we don't fix the
    // Authorization header until the user has actually pasted a token. The
    // Validate step calls setToken() once after the password prompt resolves.
    let client: HttpClient | undefined

    function getClient(): HttpClient {
      if (!client) {
        throw new Error(
          "cloudflare.setToken(token) must be called before any other cloudflare.* method",
        )
      }
      return client
    }

    /**
     * Wrap a request and convert the body's error envelope into a CfError on
     * `success === false`. Network failures (e.g. DNS, timeouts) bubble up
     * unchanged so the caller can distinguish "we never reached CF" from
     * "CF rejected our request".
     *
     * Important nuance: not every CF endpoint returns the standard
     * `{ success, errors, messages, result }` envelope. DELETE endpoints
     * (e.g. `DELETE /accounts/{id}/workers/domains/{id}`) frequently return
     * a 200 with an empty body `{}`. We treat ANY 2xx HTTP status as success
     * — only an explicit `success: false` (not just a missing field) maps
     * to a CfError.
     */
    async function request<T>(
      fn: (api: HttpClient) => Promise<HttpResponse<CfEnvelope<T>>>,
      hint?: string,
    ): Promise<T> {
      const api = getClient()
      let response: HttpResponse<CfEnvelope<T>>
      try {
        response = await fn(api)
      } catch (err) {
        // The seedcli http client throws HttpError on non-2xx by default.
        // Try to pull the response body off the error so we still surface
        // CF's structured errors instead of a generic "HTTP 401" string.
        if (err && typeof err === "object" && "data" in err && "status" in err) {
          const status = Number((err as { status: unknown }).status) || 0
          const messages = extractErrors((err as { data: unknown }).data)
          const fallbackMessage = err instanceof Error ? err.message : `HTTP ${status}`
          throw new CfError(status, messages.length > 0 ? messages : [fallbackMessage], hint)
        }
        throw err
      }
      // 2xx HTTP status → success regardless of envelope shape. Some CF
      // DELETE endpoints return `{}` and we'd false-positive if we required
      // `success: true`.
      if (response.status >= 200 && response.status < 300) {
        return (response.data?.result ?? (response.data as unknown)) as T
      }
      // Non-2xx that didn't throw → look at the envelope's `success` field.
      if (response.data?.success === false) {
        throw new CfError(response.status, extractErrors(response.data), hint)
      }
      // Non-2xx with no error envelope at all — bubble a generic error.
      throw new CfError(response.status, [`HTTP ${response.status}`], hint)
    }

    seed.cloudflare = {
      // The api getter forwards to the lazily-created client so consumers
      // can do `seed.cloudflare.api.get(...)` after setToken() runs without
      // capturing a stale reference at extension setup time.
      get api() {
        return getClient()
      },

      setToken(token: string) {
        client = http.create({
          baseURL: "https://api.cloudflare.com/client/v4",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          // Cloudflare returns 5xx + 429 fairly often during bursts. Built-in
          // retries cover the common transient cases without us having to
          // hand-roll a retry loop in every step.
          retry: { count: 3, delay: 500, backoff: "exponential" },
        })
      },

      async verifyToken() {
        const result = await request<CfTokenVerifyResult>(
          (api) => api.get<CfEnvelope<CfTokenVerifyResult>>("/user/tokens/verify"),
          "Re-create your Cloudflare API token with the listed scopes.",
        )
        // The verify endpoint doesn't include the account id, so we make a
        // second cheap call to /accounts and pick the first one. If the user
        // has multiple accounts they're prompted later to disambiguate; for
        // most installs there's exactly one account.
        const accounts = await request<Array<{ id: string; name: string }>>((api) =>
          api.get<CfEnvelope<Array<{ id: string; name: string }>>>("/accounts", {
            params: { per_page: "5" },
          }),
        )
        const accountId = accounts[0]?.id ?? ""
        return { accountId, status: result.status }
      },

      async checkAccountPrereqs(accountId: string): Promise<AccountPrereqs> {
        // Run the two checks in parallel — they're independent and each is
        // one HTTP roundtrip. Failing fast saves the user from filling in
        // the rest of the prompts only to hit a wall later.
        const [subdomainResult, r2Result] = await Promise.allSettled([
          // Workers.dev subdomain. Returns 200 with `subdomain: "name"` if
          // registered, 404 / null subdomain if not. We tolerate both shapes.
          request<{ subdomain?: string | null }>((api) =>
            api.get<CfEnvelope<{ subdomain?: string | null }>>(
              `/accounts/${accountId}/workers/subdomain`,
            ),
          ),
          // R2 enablement check. We list buckets with per_page=1 — cheap call,
          // returns 200 (with possibly-empty list) when R2 is enabled, returns
          // a CfError with code 10042 / "Please enable R2" message when it's
          // not. We don't actually care about the bucket data, only the
          // success/failure signal.
          request<unknown>((api) =>
            api.get<CfEnvelope<unknown>>(`/accounts/${accountId}/r2/buckets`, {
              params: { per_page: "1" },
            }),
          ),
        ])

        // ----- Workers.dev subdomain interpretation -----
        let workersSubdomain: string | null = null
        if (subdomainResult.status === "fulfilled") {
          const sub = subdomainResult.value?.subdomain
          workersSubdomain = sub && sub.length > 0 ? sub : null
        } else {
          // 404 / "subdomain not found" → not registered. Anything else is
          // unexpected and should bubble up so the user sees the real error.
          const err = subdomainResult.reason
          if (err instanceof CfError && (err.status === 404 || err.status === 10006)) {
            workersSubdomain = null
          } else {
            throw err
          }
        }

        // ----- R2 enablement interpretation -----
        let r2Enabled = false
        if (r2Result.status === "fulfilled") {
          r2Enabled = true
        } else {
          const err = r2Result.reason
          if (err instanceof CfError) {
            // 10042 = "Please enable R2 through the Cloudflare Dashboard".
            // Other CF errors (auth, rate limit) bubble up — we only want
            // to swallow the specific "not enabled" signal.
            const isR2Disabled = err.messages.some((m) => /enable R2|10042/i.test(m))
            if (isR2Disabled) {
              r2Enabled = false
            } else {
              throw err
            }
          } else {
            throw err
          }
        }

        return { workersSubdomain, r2Enabled }
      },

      async listZones(name: string) {
        const zones = await request<CfZone[]>(
          (api) =>
            api.get<CfEnvelope<CfZone[]>>("/zones", {
              params: { name, per_page: "50" },
            }),
          "If the zone is missing, add it at https://dash.cloudflare.com/?to=/:account/add-site first.",
        )
        return zones.map((zone) => ({
          id: zone.id,
          name: zone.name,
          status: zone.status,
          accountId: zone.account.id,
        }))
      },

      async enableEmailRouting(zoneId: string) {
        await request<unknown>(
          (api) => api.post<CfEnvelope<unknown>>(`/zones/${zoneId}/email/routing/enable`, {}),
          "Make sure the API token has Zone:Email Routing:Edit on the email zone.",
        )
      },

      async getEmailRouting(zoneId: string) {
        const settings = await request<CfEmailRoutingSettings>((api) =>
          api.get<CfEnvelope<CfEmailRoutingSettings>>(`/zones/${zoneId}/email/routing`),
        )
        return { enabled: settings.enabled, status: settings.status }
      },

      async pollMxVerified(zoneId: string, timeoutMs = 90_000) {
        const intervalMs = 5_000
        const start = Date.now()
        // First call is immediate; subsequent calls wait `intervalMs` between
        // attempts up to the timeout. We treat zero `errors` as success even
        // if the response doesn't include an explicit `verified` field —
        // CF's UI uses the same heuristic.
        while (true) {
          const dns = await request<CfEmailRoutingDnsResult>((api) =>
            api.get<CfEnvelope<CfEmailRoutingDnsResult>>(`/zones/${zoneId}/email/routing/dns`),
          )
          if (!dns.errors || dns.errors.length === 0) {
            return true
          }
          if (Date.now() - start >= timeoutMs) {
            return false
          }
          await new Promise((resolve) => setTimeout(resolve, intervalMs))
        }
      },

      async upsertCatchAll(zoneId: string, workerName: string) {
        const body = {
          name: "cloakmail-catchall",
          enabled: true,
          matchers: [{ type: "all" }],
          actions: [{ type: "worker", value: [workerName] }],
        }
        // GET first to see if a catch-all rule already exists. If so, PUT to
        // update; otherwise POST a fresh one. The catch-all endpoint accepts
        // both methods on the same path; we route by existence to keep the
        // wire shape minimal and avoid 404 spam in the user's audit log.
        let exists = false
        try {
          await request<CfEmailRoutingRule>((api) =>
            api.get<CfEnvelope<CfEmailRoutingRule>>(
              `/zones/${zoneId}/email/routing/rules/catch_all`,
            ),
          )
          exists = true
        } catch (err) {
          if (err instanceof CfError && err.status !== 404) {
            throw err
          }
        }

        if (exists) {
          await request<CfEmailRoutingRule>(
            (api) =>
              api.put<CfEnvelope<CfEmailRoutingRule>>(
                `/zones/${zoneId}/email/routing/rules/catch_all`,
                body,
              ),
            "Catch-all rule update failed.",
          )
        } else {
          await request<CfEmailRoutingRule>(
            (api) =>
              api.post<CfEnvelope<CfEmailRoutingRule>>(
                `/zones/${zoneId}/email/routing/rules/catch_all`,
                body,
              ),
            "Catch-all rule creation failed.",
          )
        }
      },

      async bindCustomDomain({ accountId, hostname, serviceName, zoneId }) {
        const body = {
          environment: "production",
          hostname,
          service: serviceName,
          zone_id: zoneId,
        }
        try {
          await request<CfWorkerDomain>(
            (api) =>
              api.put<CfEnvelope<CfWorkerDomain>>(`/accounts/${accountId}/workers/domains`, body),
            "Custom domain binding failed.",
          )
          return { created: true }
        } catch (err) {
          if (err instanceof CfError && err.status === 409) {
            // Look up what the existing binding points at so the caller can
            // either skip (same service) or prompt-and-overwrite (different).
            try {
              const existing = await request<CfWorkerDomain[]>((api) =>
                api.get<CfEnvelope<CfWorkerDomain[]>>(`/accounts/${accountId}/workers/domains`, {
                  params: { hostname },
                }),
              )
              const match = existing.find((d) => d.hostname === hostname)
              if (match && match.service === serviceName) {
                return { created: false }
              }
              return {
                created: false,
                conflictDifferentService: match?.service ?? "unknown",
              }
            } catch {
              // If even the lookup fails, surface the original 409 so the
              // user gets the actual CF error message instead of our guess.
              throw err
            }
          }
          throw err
        }
      },

      async unbindCustomDomain({ accountId, hostname }) {
        // Look up the domain id by hostname (the delete endpoint takes the
        // domain id, not the hostname directly).
        let domains: CfWorkerDomain[]
        try {
          domains = await request<CfWorkerDomain[]>((api) =>
            api.get<CfEnvelope<CfWorkerDomain[]>>(`/accounts/${accountId}/workers/domains`, {
              params: { hostname },
            }),
          )
        } catch (err) {
          if (err instanceof CfError && err.status === 404) {
            // No domains list at all — nothing to unbind.
            return
          }
          throw err
        }
        const match = domains.find((d) => d.hostname === hostname)
        if (!match) return // already gone
        try {
          await request<unknown>(
            (api) =>
              api.delete<CfEnvelope<unknown>>(`/accounts/${accountId}/workers/domains/${match.id}`),
            "Custom domain unbind failed.",
          )
        } catch (err) {
          if (err instanceof CfError && err.status === 404) return // already gone
          throw err
        }
      },

      async deleteCatchAll(zoneId: string) {
        // Cloudflare's catch_all rule can't be removed once Email Routing
        // is enabled — only disabled. We disable it by PUT-ing the rule
        // with `enabled: false` and an empty drop action so future inbound
        // mail bounces instead of being routed to a non-existent worker.
        const body = {
          name: "cloakmail-catchall",
          enabled: false,
          matchers: [{ type: "all" }],
          actions: [{ type: "drop" }],
        }
        try {
          await request<CfEmailRoutingRule>(
            (api) =>
              api.put<CfEnvelope<CfEmailRoutingRule>>(
                `/zones/${zoneId}/email/routing/rules/catch_all`,
                body,
              ),
            "Catch-all rule disable failed.",
          )
        } catch (err) {
          if (err instanceof CfError && err.status === 404) return // already gone
          throw err
        }
      },

      async disableEmailRouting(zoneId: string) {
        try {
          await request<unknown>(
            (api) => api.post<CfEnvelope<unknown>>(`/zones/${zoneId}/email/routing/disable`, {}),
            "Email Routing disable failed.",
          )
        } catch (err) {
          if (err instanceof CfError && err.status === 404) return // already disabled
          throw err
        }
      },

      async deleteWorker({ accountId, scriptName }) {
        try {
          await request<unknown>(
            (api) =>
              api.delete<CfEnvelope<unknown>>(
                `/accounts/${accountId}/workers/scripts/${scriptName}`,
              ),
            "Worker script delete failed.",
          )
        } catch (err) {
          if (err instanceof CfError && err.status === 404) return // already gone
          throw err
        }
      },
    }
  },
})
