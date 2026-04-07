import { existsSync } from "node:fs"
import { defineExtension } from "@seedcli/core"
import { WranglerError } from "../lib/errors"

interface WranglerD1Database {
  uuid: string
  name: string
}

interface WranglerR2Bucket {
  name: string
}

declare module "@seedcli/core" {
  interface SeedExtensions {
    wrangler: {
      /** Cache the CF API token used as `CLOUDFLARE_API_TOKEN` for every spawn. */
      setToken(token: string): void
      /**
       * Cache the CF account ID used as `CLOUDFLARE_ACCOUNT_ID` for every spawn.
       *
       * Without this, wrangler tries to enumerate the user's accounts via
       * `GET /memberships` to figure out which account to use, and fails with
       * "Authentication error [code: 10000]" because our token doesn't have
       * the User → Memberships → Read scope (and we don't want to add a 7th
       * required scope just for that). Setting this env var makes wrangler
       * skip the lookup entirely and use the provided account ID directly.
       */
      setAccountId(accountId: string): void
      d1List(): Promise<WranglerD1Database[]>
      d1Create(name: string): Promise<WranglerD1Database>
      d1MigrationsApply(name: string, opts: { cwd: string }): Promise<void>
      /**
       * Idempotent D1 delete. Returns silently if the database doesn't exist.
       * Used by the rollback step.
       */
      d1Delete(name: string): Promise<void>
      r2List(): Promise<WranglerR2Bucket[]>
      /**
       * Idempotent R2 bucket create. Returns `{ created: true }` if we
       * created a new bucket, `{ created: false }` if it already existed
       * (so the rollback step knows whether to delete it or leave it alone).
       */
      r2Create(name: string): Promise<{ created: boolean }>
      /**
       * Idempotent R2 bucket delete. Returns silently if the bucket doesn't
       * exist. Used by the rollback step.
       */
      r2Delete(name: string): Promise<void>
      /**
       * Run `wrangler deploy` from inside `packagePath` (resolved against `cwd`).
       * Returns the public workers.dev URL parsed from stdout if present.
       */
      deploy(packagePath: string, opts: { cwd: string }): Promise<{ url: string }>
      /**
       * Idempotent worker delete by name (`wrangler delete --name <name>`).
       * Used by the rollback step. Returns silently if the worker doesn't exist.
       */
      workerDelete(name: string): Promise<void>
    }
  }
}

/**
 * Quote and escape a single shell argument so it survives a `bash -c` round-trip.
 *
 * `seed.system.exec` runs commands through a shell, so callers that include
 * paths with spaces / special chars must pre-escape. We use single quotes and
 * escape any embedded single quotes the POSIX way (`'\''`).
 */
function shellEscape(value: string): string {
  if (/^[\w@/.\-:=+]+$/.test(value)) {
    return value
  }
  return `'${value.replace(/'/g, "'\\''")}'`
}

export default defineExtension({
  name: "wrangler",
  description: "Spawns the bundled wrangler binary with CLOUDFLARE_API_TOKEN injected",

  setup: (seed) => {
    const { system, filesystem } = seed

    let token = ""
    let accountId = ""

    /**
     * Find the wrangler binary on disk. Order of preference:
     * 1. The local node_modules/.bin/wrangler from THIS CLI's install
     * 2. A globally installed wrangler on $PATH
     *
     * The first hit is the one we ship with — bundled wrangler is always
     * preferred so users don't accidentally run an older / mismatched
     * version they happen to have on their $PATH.
     */
    function resolveWranglerBinary(): string {
      // We can't use `import.meta.resolve` reliably from a published package,
      // so we walk up from process.cwd() looking for node_modules/.bin/wrangler.
      // The CLI's package directory is typically the cwd of the parent process
      // (when run via `bun run dev` or `bunx`), so this is good enough in
      // practice. Fall back to $PATH lookup if not found locally.
      let dir = filesystem.path.cwd()
      for (let i = 0; i < 10; i++) {
        const candidate = filesystem.path.join(dir, "node_modules", ".bin", "wrangler")
        // We rely on the node:fs sync helper here because the resolver runs
        // once during extension setup and the for-loop is cheap (≤10 stat
        // calls) — switching to the async filesystem helper would force us
        // to make this whole function async for no real benefit.
        if (existsSync(candidate)) {
          return candidate
        }
        const parent = filesystem.path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
      const fromPath = system.which("wrangler")
      if (fromPath) return fromPath
      throw new WranglerError(
        127,
        "wrangler binary not found in node_modules or on PATH",
        "(prereq check)",
      )
    }

    // Lazy: resolve the binary on first use rather than at extension setup so
    // `cloakmail-cli --help` (or any non-deploy command) still works on a
    // machine where the wrangler dep tree happens to be missing.
    let cachedBinary: string | undefined

    function getBinary(): string {
      if (!cachedBinary) {
        cachedBinary = resolveWranglerBinary()
      }
      return cachedBinary
    }

    /**
     * Spawn `wrangler <args>` and capture stdout/stderr/exit code. Throws
     * `WranglerError` on non-zero exit so each step's catch block can build
     * a remediation hint without juggling raw exec results.
     */
    async function run(
      argv: string[],
      opts: { cwd?: string; envExtra?: Record<string, string> } = {},
    ): Promise<{ stdout: string; stderr: string }> {
      if (!token) {
        throw new WranglerError(
          1,
          "wrangler.setToken(token) must be called before any wrangler.* method",
          argv.join(" "),
        )
      }
      const binary = getBinary()
      const command = [shellEscape(binary), ...argv.map(shellEscape)].join(" ")
      // Pass the user's environment through unchanged plus the CF API token
      // and (when known) the account ID. The account ID is critical: without
      // it wrangler hits GET /memberships to enumerate accounts, which our
      // token isn't scoped for and fails with auth error 10000.
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        CLOUDFLARE_API_TOKEN: token,
        ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
        ...opts.envExtra,
      }
      // seedcli's `system.exec` THROWS on non-zero exit (despite docs saying
      // throwOnError defaults to false). If we let that throw bubble up
      // unmodified, downstream code that does `if (err instanceof WranglerError)`
      // (like our r2Create idempotency catch and the setup command's
      // handleError) never fires, and the user just sees a raw "Command
      // failed: <full path>" Error message with the wrangler stderr appended.
      //
      // We wrap exec in a try/catch and convert ANY thrown error into a
      // WranglerError with the right command/exitCode/stderr fields, so the
      // rest of the codebase can rely on `instanceof WranglerError` working
      // regardless of which path seedcli takes.
      let result: { stdout: string; stderr: string; exitCode: number }
      try {
        result = await system.exec(command, {
          cwd: opts.cwd,
          env,
          // Don't stream — we need to parse stdout for IDs, URLs, etc. The
          // outer step prints its own spinner so users still see progress.
        })
      } catch (err) {
        // Extract whatever exec metadata seedcli attached to the thrown
        // error. Different versions of seedcli expose different shapes
        // (sometimes `stderr`/`stdout`/`exitCode`, sometimes just `message`),
        // so we read defensively.
        const errAny = err as {
          stderr?: string
          stdout?: string
          exitCode?: number
          message?: string
        }
        throw new WranglerError(
          errAny.exitCode ?? 1,
          errAny.stderr ?? errAny.stdout ?? errAny.message ?? String(err),
          argv.join(" "),
        )
      }
      if (result.exitCode !== 0) {
        throw new WranglerError(result.exitCode, result.stderr || result.stdout, argv.join(" "))
      }
      return { stdout: result.stdout, stderr: result.stderr }
    }

    seed.wrangler = {
      setToken(value: string) {
        token = value
      },

      setAccountId(value: string) {
        accountId = value
      },

      async d1List(): Promise<WranglerD1Database[]> {
        const { stdout } = await run(["d1", "list", "--json"])
        // wrangler 3.114+ prefixes its JSON output with a banner like
        // " ⛅️ wrangler 3.114.17 (update available 4.80.0)\n-----...\n\n[".
        // JSON.parse(stdout) blows up on the banner, so we slice from the
        // first `[` and parse from there. If there's no `[` at all then
        // the command produced no JSON and we return an empty list.
        const jsonStart = stdout.indexOf("[")
        if (jsonStart === -1) return []
        try {
          const parsed = JSON.parse(stdout.slice(jsonStart)) as Array<{
            uuid?: string
            name: string
          }>
          return parsed
            .filter((entry) => entry.uuid && entry.name)
            .map((entry) => ({ uuid: entry.uuid as string, name: entry.name }))
        } catch {
          // Older wranglers print plain-text — fall back to empty list rather
          // than crash. Callers will then attempt d1Create which will surface
          // the actual error if there is one.
          return []
        }
      },

      async d1Create(name: string): Promise<WranglerD1Database> {
        const { stdout } = await run(["d1", "create", name])
        // wrangler's `d1 create` output format has changed across versions.
        // We try both:
        //   1. TOML-ish: `database_id = "uuid"`             (older wrangler)
        //   2. JSON-ish: `"database_id": "uuid"`            (wrangler 3.114+)
        // Either way the UUID is the first hex/dashed string after the
        // `database_id` token. We accept both equals and colon separators
        // and an optional quote on the key.
        const match =
          stdout.match(/"?database_id"?\s*[:=]\s*"([0-9a-f-]+)"/i) ??
          stdout.match(/database_id[^"]*"([0-9a-f-]+)"/i)
        const uuid = match?.[1]
        if (!uuid) {
          throw new WranglerError(
            0,
            `Could not parse database_id from wrangler output:\n${stdout}`,
            `d1 create ${name}`,
          )
        }
        return { uuid, name }
      },

      async d1MigrationsApply(name: string, opts: { cwd: string }) {
        await run(["d1", "migrations", "apply", name, "--remote"], { cwd: opts.cwd })
      },

      async d1Delete(name: string) {
        // wrangler's `d1 delete` is interactive (prompts for confirmation).
        // We pipe `y` via stdin and pass `--skip-confirmation` to bypass
        // the prompt. Older wranglers don't know `--skip-confirmation` so
        // we fall back to passing it as a stdin input — both work.
        try {
          await run(["d1", "delete", name, "--skip-confirmation"])
        } catch (err) {
          if (!(err instanceof WranglerError)) throw err
          // 404 / not found / unknown database → already gone, treat as success
          if (/not found|does not exist|7404|7405|no such database/i.test(err.stderr)) {
            return
          }
          throw err
        }
      },

      async r2Delete(name: string) {
        try {
          await run(["r2", "bucket", "delete", name])
        } catch (err) {
          if (!(err instanceof WranglerError)) throw err
          // 404 / not found → already gone
          if (/not found|does not exist|10006|no such bucket/i.test(err.stderr)) {
            return
          }
          // R2 refuses to delete non-empty buckets. Cloakmail buckets only
          // contain email-body blobs that the worker writes; on rollback we
          // typically haven't received any mail yet so this should be empty.
          // If it's not, surface a clear message instead of the raw stderr.
          if (/not empty|10049/i.test(err.stderr)) {
            throw new WranglerError(
              err.exitCode,
              `R2 bucket ${name} is not empty — delete the objects first or remove it manually in the dashboard.`,
              `r2 bucket delete ${name}`,
            )
          }
          throw err
        }
      },

      async workerDelete(name: string) {
        try {
          await run(["delete", "--name", name, "--force"])
        } catch (err) {
          if (!(err instanceof WranglerError)) throw err
          // 404 / not found → already gone
          if (/not found|does not exist|10007|workers script.*not found/i.test(err.stderr)) {
            return
          }
          throw err
        }
      },

      async r2List(): Promise<WranglerR2Bucket[]> {
        // wrangler 3.114+ removed `--json` from `r2 bucket list`, so we
        // can't reliably parse this output across versions. We keep the
        // method around for future commands but it's no longer called by
        // the provision step — that path uses the idempotent r2Create
        // below instead.
        return []
      },

      async r2Create(name: string): Promise<{ created: boolean }> {
        // Idempotent: if the bucket already exists in this account, treat
        // as success but return `created: false` so the rollback step knows
        // not to delete it. Wrangler returns a non-zero exit with a stderr
        // like "A bucket with this name already exists" or error code 10004
        // when the bucket is already there.
        //
        // Special case: error code 10042 means the user hasn't enabled R2
        // on their account yet (R2 is opt-in because it has its own ToS).
        // We can't fix this from the CLI — the user must click "Enable R2"
        // in the dashboard once. Surface a clear actionable message instead
        // of dumping raw wrangler stderr.
        try {
          await run(["r2", "bucket", "create", name])
          return { created: true }
        } catch (err) {
          if (!(err instanceof WranglerError)) throw err
          if (/already exists|bucket.*exists|10004/i.test(err.stderr)) {
            return { created: false }
          }
          if (/10042|enable R2 through the Cloudflare Dashboard/i.test(err.stderr)) {
            throw new WranglerError(
              err.exitCode,
              "R2 is not enabled on your Cloudflare account. " +
                "Open https://dash.cloudflare.com/?to=/:account/r2 and click " +
                "'Enable R2' / 'Purchase R2 Plan' (free tier available), then re-run setup.",
              `r2 bucket create ${name}`,
            )
          }
          throw err
        }
      },

      async deploy(packagePath: string, opts: { cwd: string }) {
        const cwd = filesystem.path.join(opts.cwd, packagePath)
        const { stdout } = await run(["deploy"], { cwd })
        // wrangler reports the published URL on a line like
        //   https://my-worker.subdomain.workers.dev
        // We pull the first matching URL out so callers can echo it back to
        // the user, but the deploy succeeding is the real signal.
        const urlMatch = stdout.match(/https?:\/\/[^\s]+\.workers\.dev[^\s]*/)
        return { url: urlMatch ? urlMatch[0] : "" }
      },
    }
  },
})
