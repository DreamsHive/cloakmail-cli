import { defineExtension } from "@seedcli/core"

/**
 * Manifest of resources the wizard CREATED (vs reused) during the current
 * setup attempt. Used by the rollback step to know what to clean up on
 * failure — anything NOT in this manifest was either pre-existing or never
 * created at all and should not be touched.
 *
 * Every field is optional and gets populated incrementally as each phase
 * succeeds. On rollback we walk these fields in reverse order (domain →
 * routing → workers → R2 → D1) and call the matching delete operation.
 */
export interface CreationManifest {
  /** D1 database we created (omitted when we reused an existing one). */
  d1?: { name: string; uuid: string }
  /** R2 bucket we created (omitted when we reused an existing one). */
  r2?: { name: string }
  /** API Worker name we deployed. */
  api_worker?: string
  /** Web Worker name we deployed. */
  web_worker?: string
  /** True iff Email Routing was OFF before our run and we turned it on. */
  email_routing_enabled_by_us?: boolean
  /** True iff we created the catch-all routing rule. */
  catch_all_rule_created?: boolean
  /** Custom domain hostname we bound to the web worker. */
  custom_domain?: { hostname: string }
}

/**
 * Persisted wizard state.
 *
 * Every value the user provides during `cloakmail-cli setup` lives here so
 * subsequent runs can resume / re-verify without re-prompting. The token is
 * only persisted when the user explicitly opts in via `--save-token`; by
 * default it stays memory-only and is re-prompted on every run.
 */
export interface CloakmailState {
  email_zone?: string
  web_hostname?: string
  account_id?: string
  email_zone_id?: string
  web_zone_id?: string
  api_worker_name?: string
  web_worker_name?: string
  /**
   * The web worker's `*.workers.dev` URL, captured from wrangler's deploy
   * output. Used by the verify step's health probe — it's always reachable
   * (no DNS propagation lag like a fresh custom domain) and exercises the
   * exact same SvelteKit hook → service binding → API worker code path.
   */
  web_worker_url?: string
  d1_name?: string
  d1_id?: string
  r2_name?: string
  email_ttl_seconds?: string
  max_email_size_mb?: string
  app_name?: string
  /** Only persisted when the user passes --save-token. */
  api_token?: string
  /** Phase index of the last successfully completed step (1..9). */
  last_completed_phase?: number
  /** Cloakmail manifest version captured at the last successful run. */
  cloakmail_version?: string
  /**
   * Resources THIS wizard run created. Walked in reverse on rollback.
   * Cleared at the end of a successful run so a re-run starts fresh.
   */
  created_by_wizard?: CreationManifest
}

/**
 * Type augmentation so any command (or step) can access `seed.state` with
 * full IntelliSense — including the in-memory cache returned from `load()`.
 */
declare module "@seedcli/core" {
  interface SeedExtensions {
    state: {
      load(): Promise<CloakmailState>
      save(partial: Partial<CloakmailState>): Promise<void>
      /**
       * Merge fields into `created_by_wizard` without clobbering existing
       * entries. Used by each phase to record what it created so the
       * rollback step has a complete manifest.
       */
      recordCreated(partial: Partial<CreationManifest>): Promise<void>
      clear(): Promise<void>
      /** Absolute path to ~/.cloakmail-cli/state.json (for messages). */
      path: string
    }
  }
}

export default defineExtension({
  name: "state",
  description: "Reads and writes ~/.cloakmail-cli/state.json for resumable runs",

  setup: async (seed) => {
    const { filesystem } = seed
    const stateDir = filesystem.path.join(filesystem.path.home(), ".cloakmail-cli")
    const statePath = filesystem.path.join(stateDir, "state.json")

    // The in-memory cache is hydrated lazily by load() and reused across
    // multiple save() calls so each step doesn't re-read the file.
    let cache: CloakmailState | undefined

    seed.state = {
      path: statePath,

      async load(): Promise<CloakmailState> {
        if (cache) return cache
        const exists = await filesystem.exists(statePath)
        if (!exists) {
          cache = {}
          return cache
        }
        try {
          cache = await filesystem.readJson<CloakmailState>(statePath)
          return cache
        } catch (err) {
          // Bad JSON gets surfaced as an error rather than silently wiping
          // the file. The validate step turns this into a "pass --reset to
          // start fresh" message.
          const reason = err instanceof Error ? err.message : String(err)
          throw new Error(`Failed to parse ${statePath}: ${reason}. Pass --reset to start fresh.`)
        }
      },

      async save(partial: Partial<CloakmailState>): Promise<void> {
        const current = await this.load()
        const next: CloakmailState = { ...current, ...partial }
        await filesystem.ensureDir(stateDir)
        // 0o600 perms are best-effort; on Windows the call is a no-op but
        // there's no token-on-disk threat model there in the first place.
        await filesystem.writeJson(statePath, next, { indent: 2 })
        cache = next
      },

      async recordCreated(partial: Partial<CreationManifest>): Promise<void> {
        // Deep merge into created_by_wizard so each phase can append its
        // own entry without clobbering ones written by earlier phases.
        const current = await this.load()
        const next: CloakmailState = {
          ...current,
          created_by_wizard: {
            ...(current.created_by_wizard ?? {}),
            ...partial,
          },
        }
        await filesystem.ensureDir(stateDir)
        await filesystem.writeJson(statePath, next, { indent: 2 })
        cache = next
      },

      async clear(): Promise<void> {
        cache = {}
        if (await filesystem.exists(statePath)) {
          await filesystem.remove(statePath)
        }
      },
    }
  },
})
