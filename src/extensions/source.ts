import { spawn } from "node:child_process"
import { defineExtension } from "@seedcli/core"
import { AcquireError } from "../lib/errors"

/**
 * Schema of `packages/cloudflare/.cli-manifest.json` inside the cloakmail
 * source tree. The CLI reads this file after acquiring the source so it can
 * (a) discover where the templates and migrations live in case the cloakmail
 * repo restructures, and (b) refuse to run against a cloakmail version that
 * needs a newer CLI than this one.
 *
 * Note: `cloakmail_version` is OPTIONAL — it's a defensive fallback only
 * used when `--from` mode can't get a `git describe` result AND the tarball
 * acquisition path doesn't apply. In all other cases the CLI computes the
 * version dynamically (git describe for --from, the requested tag or the
 * GitHub Releases API for tarball mode) so the manifest never has to be
 * kept in sync by hand.
 */
export interface CloakmailManifest {
  cloakmail_version?: string
  min_cli_version: string
  templates: {
    api_wrangler_toml: string
    web_wrangler_toml: string
  }
  migrations: string
  deployable_packages: string[]
}

/**
 * Result of `seed.source.acquire(...)`. Holds the absolute root of the
 * acquired cloakmail tree (so subsequent steps can `path.join(root, ...)`
 * any of the manifest paths), the parsed manifest, and the dynamically
 * resolved version string.
 */
export interface AcquiredSource {
  root: string
  manifest: CloakmailManifest
  /**
   * The version string the CLI displays/persists for this acquisition.
   *
   * Resolution order:
   *   1. `--from` mode: `git describe --tags --always --dirty` against the
   *      local checkout (e.g. `v1.0.0-8-gabc1234-dirty`). Falls back to the
   *      manifest's `cloakmail_version` if git is unavailable, then `local`.
   *   2. Tarball mode with explicit `--version`: the value as-is.
   *   3. Tarball mode without `--version`: the latest GitHub release tag,
   *      via `GET https://api.github.com/repos/.../releases/latest`. Falls
   *      back to `main` if the API call fails or no releases exist yet.
   */
  version: string
}

declare module "@seedcli/core" {
  interface SeedExtensions {
    source: {
      acquire(opts: { from?: string; version?: string }): Promise<AcquiredSource>
      /** Absolute path to the acquired cloakmail source root. Empty string until acquire() runs. */
      root: string
      /** Cached manifest from the acquired source. Undefined until acquire() runs. */
      manifest?: CloakmailManifest
      /** Resolved version of the acquired source. Empty string until acquire() runs. */
      version: string
    }
  }
}

/** GitHub repo coordinates. Hardcoded for now — could be configurable later. */
const GITHUB_OWNER = "DreamsHive"
const GITHUB_REPO = "cloakmail"

/**
 * Compare two semver-ish version strings (`major.minor.patch`).
 * Returns -1 / 0 / 1 like `String.prototype.localeCompare`. Drops any
 * pre-release suffix (`v1.0.0-beta.1` → `1.0.0`) before comparing.
 *
 * Lightweight on purpose — pulling in `@seedcli/semver` for one comparison
 * would balloon the dependency surface for no real benefit. We don't need
 * range matching, just "is the manifest's `min_cli_version` <= our version".
 */
function compareVersions(a: string, b: string): number {
  const normalize = (raw: string) => {
    const head = raw.replace(/^v/, "").split("-")[0] ?? "0"
    return head.split(".").map((segment) => Number.parseInt(segment, 10) || 0)
  }

  const aParts = normalize(a)
  const bParts = normalize(b)
  const length = Math.max(aParts.length, bParts.length)
  for (let i = 0; i < length; i++) {
    const left = aParts[i] ?? 0
    const right = bParts[i] ?? 0
    if (left > right) return 1
    if (left < right) return -1
  }
  return 0
}

/**
 * Spawn `tar -xzf <archivePath> -C <destDir>` with argv passed directly to
 * the OS — no shell, no cmd.exe, no quote parsing. Archive and destination
 * paths are distinct argv entries, so they can contain spaces, backslashes,
 * or any other filesystem-legal character without tar ever seeing a literal
 * quote character. This is the fix for issue #5 on Windows, where the
 * previous `system.exec(\`tar -xzf "${path}" ...\`)` shape routed the
 * archive path through `cmd /c`'s quote parser and delivered it with
 * literal `"` chars still attached.
 *
 * Exported as a module-level named export so `tests/source.test.ts` can
 * drive it directly (via a mocked `node:child_process.spawn`) without
 * standing up the full acquire pipeline.
 */
export async function extractTarballToDir(
  archivePath: string,
  destDir: string,
  version: string,
): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archivePath, "-C", destDir], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    })
    let stderr = ""
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          new AcquireError(
            "Failed to extract cloakmail tarball: tar is required but was not found on PATH. " +
              "On Windows 10+ tar ships at C:\\Windows\\System32\\tar.exe; " +
              "on macOS/Linux install it via the system package manager.",
            version,
          ),
        )
        return
      }
      reject(new AcquireError(`Failed to extract cloakmail tarball: ${err.message}`, version))
    })
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      const tail = stderr.trimEnd() || "no stderr output"
      if (code === 0) {
        resolve()
        return
      }
      if (typeof code === "number") {
        reject(
          new AcquireError(
            `Failed to extract cloakmail tarball (tar exit ${code}): ${stderr.trimEnd() || "tar exited with non-zero status"}`,
            version,
          ),
        )
        return
      }
      // code === null — child was terminated before exiting normally.
      // Differentiate signal vs. no-signal so the user-facing message is
      // always specific; we never want to emit the nonsense string
      // `tar exit null`.
      if (signal != null) {
        reject(
          new AcquireError(
            `Failed to extract cloakmail tarball: tar terminated by signal ${signal}: ${tail}`,
            version,
          ),
        )
        return
      }
      reject(
        new AcquireError(
          `Failed to extract cloakmail tarball: tar exited without a status code: ${tail}`,
          version,
        ),
      )
    })
  })
}

export default defineExtension({
  name: "source",
  description: "Acquires the cloakmail source tree (--from path or GitHub tarball)",

  setup: async (seed) => {
    const { filesystem, http, system, meta, print } = seed

    const cliVersion = meta.version
    const cacheRoot = filesystem.path.join(filesystem.path.home(), ".cloakmail-cli", "cache")

    // Mutable state attached to seed.source. The extension contract requires
    // a `root` field even before `acquire()` is called, so we initialize it
    // to an empty string and let TypeScript callers narrow via the manifest.
    const state = {
      path: "" as string,
      manifest: undefined as CloakmailManifest | undefined,
      version: "" as string,
    }

    /**
     * Run `git describe --tags --always --dirty` inside a local cloakmail
     * checkout. Returns the result on success, or null if git isn't
     * installed, the directory isn't a git repo, or the command fails for
     * any other reason. Used by `--from` mode to derive a real version
     * string instead of relying on the manifest's static field.
     */
    async function gitDescribe(repoRoot: string): Promise<string | null> {
      if (!system.which("git")) return null
      try {
        const result = await system.exec(
          `git -C "${repoRoot}" describe --tags --always --dirty 2>/dev/null`,
        )
        if (result.exitCode !== 0) return null
        const trimmed = result.stdout.trim()
        return trimmed.length > 0 ? trimmed : null
      } catch {
        return null
      }
    }

    /**
     * Hit the GitHub Releases API for the latest tag of the cloakmail repo.
     * Returns the tag name (e.g. `v1.2.0`) on success, or null if there are
     * no releases yet, the API is rate-limiting us, or the network is down.
     * Used by tarball mode when `--version` was not explicitly given so the
     * default points at the actual latest release rather than `main`.
     *
     * Unauthenticated. GitHub allows 60 requests/hour from a given IP without
     * a token, which is plenty for a setup wizard that runs ~once per
     * deployment.
     */
    async function resolveLatestRelease(): Promise<string | null> {
      const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
      try {
        const response = await http.get<{ tag_name?: string }>(url, {
          timeout: 5_000,
          headers: { Accept: "application/vnd.github+json" },
        })
        const tag = response.data?.tag_name
        return tag && tag.length > 0 ? tag : null
      } catch {
        // 404 (no releases yet), 403 (rate limited), network errors — all
        // map to "we don't know, fall back to the default branch".
        return null
      }
    }

    async function readManifest(root: string): Promise<CloakmailManifest> {
      // The manifest's relative location inside cloakmail is itself fixed —
      // it's the one path that has to be hardcoded so the CLI can find the
      // rest of the contract. The manifest's content then declares all the
      // other paths the CLI uses (templates, migrations, deployable_packages).
      const manifestPath = filesystem.path.join(
        root,
        "packages",
        "cloudflare",
        ".cli-manifest.json",
      )
      const exists = await filesystem.exists(manifestPath)
      if (!exists) {
        throw new AcquireError(
          `cloakmail source at ${root} is missing packages/cloudflare/.cli-manifest.json. ` +
            "It does not look like a cloakmail checkout.",
        )
      }
      try {
        return await filesystem.readJson<CloakmailManifest>(manifestPath)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        throw new AcquireError(`Failed to parse ${manifestPath}: ${reason}`)
      }
    }

    function assertCompatible(manifest: CloakmailManifest, resolvedVersion: string): void {
      if (compareVersions(cliVersion, manifest.min_cli_version) < 0) {
        throw new AcquireError(
          `cloakmail ${resolvedVersion} requires cloakmail-cli >= ${manifest.min_cli_version}, ` +
            `but this CLI is v${cliVersion}. Run \`bun update -g cloakmail-cli\` and re-run.`,
          resolvedVersion,
        )
      }
    }

    seed.source = {
      get root() {
        return state.path
      },
      get manifest() {
        return state.manifest
      },
      get version() {
        return state.version
      },

      async acquire(opts: { from?: string; version?: string }): Promise<AcquiredSource> {
        // SPINNER DISCIPLINE: this function is the sole owner of all visual
        // feedback for the acquire phase. 03-acquire.ts intentionally does NOT
        // wrap us in an outer spinner — a previous version did, and it
        // triggered ora's "Multiple concurrent spinners detected" warning
        // every time we started the inner lookup spinner below. The rule
        // going forward: at most one spinner is active at a time, and each
        // spinner must be .succeed()/.fail()/.warn()'d before the next one
        // is created.

        // Mode 1 — local checkout. Used for cloakmail dev or running a fork.
        // Version comes from `git describe` if possible, manifest fallback
        // otherwise, "local" as the last resort. Fast enough that a single
        // spinner covering the whole "read manifest + git describe" dance is
        // the right granularity.
        if (opts.from) {
          const fromSpinner = print.spin(`Using local cloakmail checkout at ${opts.from}...`)
          try {
            const absolute = filesystem.path.isAbsolute(opts.from)
              ? opts.from
              : filesystem.path.resolve(opts.from)
            if (!(await filesystem.isDirectory(absolute))) {
              throw new AcquireError(`--from path is not a directory: ${absolute}`)
            }
            const manifest = await readManifest(absolute)
            const gitVersion = await gitDescribe(absolute)
            const resolvedVersion = gitVersion ?? manifest.cloakmail_version ?? "local"
            assertCompatible(manifest, resolvedVersion)
            state.path = absolute
            state.manifest = manifest
            state.version = resolvedVersion
            fromSpinner.succeed(`Using cloakmail ${resolvedVersion} at ${absolute}`)
            return { root: absolute, manifest, version: resolvedVersion }
          } catch (err) {
            fromSpinner.fail("Failed to use local cloakmail checkout")
            throw err
          }
        }

        // Mode 2 — GitHub tarball. Cached by version under
        // ~/.cloakmail-cli/cache/cloakmail-{version}/.
        //
        // Resolution order:
        //   1. opts.version (explicit `--version` flag)
        //   2. GitHub Releases API (`releases/latest`)
        //   3. `main` branch (fallback when there are no releases yet)
        let version: string
        if (opts.version) {
          version = opts.version
        } else {
          const lookupSpinner = print.spin("Looking up latest cloakmail release on GitHub...")
          try {
            const latest = await resolveLatestRelease()
            if (latest) {
              lookupSpinner.succeed(`Latest release is ${latest}`)
              version = latest
            } else {
              lookupSpinner.warn("No GitHub release found; falling back to main branch")
              version = "main"
            }
          } catch (err) {
            lookupSpinner.fail("Failed to look up latest cloakmail release")
            throw err
          }
        }
        const extractedDir = filesystem.path.join(cacheRoot, `cloakmail-${version}`)

        // Cache hit path — still show a (short) spinner so the user sees the
        // status line for consistency with the miss path. It's cheap even if
        // the work is nearly instant.
        if (await filesystem.isDirectory(extractedDir)) {
          const cacheSpinner = print.spin(`Using cached cloakmail ${version}...`)
          try {
            const manifest = await readManifest(extractedDir)
            assertCompatible(manifest, version)
            state.path = extractedDir
            state.manifest = manifest
            state.version = version
            cacheSpinner.succeed(`Using cached cloakmail ${version} at ${extractedDir}`)
            return { root: extractedDir, manifest, version }
          } catch (err) {
            cacheSpinner.fail(`Failed to load cached cloakmail ${version}`)
            throw err
          }
        }

        await filesystem.ensureDir(cacheRoot)

        // Tag URL form. Branches use a different scheme; we hardcode the
        // tarball endpoint that always works for both. GitHub's `tarball/`
        // endpoint also works but we picked `archive/refs/{tags|heads}` to
        // match the user-facing URL the README documents.
        const tarballPath = filesystem.path.join(cacheRoot, `cloakmail-${version}.tar.gz`)
        const isBranch = version === "main" || version === "master"
        const tarballUrl = isBranch
          ? `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/archive/refs/heads/${version}.tar.gz`
          : `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/archive/refs/tags/${version}.tar.gz`

        const downloadSpinner = print.spin(`Downloading cloakmail ${version} from GitHub...`)
        try {
          await http.download(tarballUrl, tarballPath)
          downloadSpinner.succeed(`Downloaded cloakmail ${version}`)
        } catch (err) {
          downloadSpinner.fail(`Failed to download cloakmail ${version}`)
          const reason = err instanceof Error ? err.message : String(err)
          throw new AcquireError(
            `Failed to download cloakmail ${version} from ${tarballUrl}: ${reason}. ` +
              "Check your network or pass --version <other-tag>.",
            version,
          )
        }

        // GitHub's archive tarballs unpack into a directory named
        // `{repo}-{version}/`. We don't know the exact name in advance
        // (branch tarballs use the branch name, tag tarballs use the bare
        // tag without the leading `v`), so we extract into a temp dir and
        // rename the single child to our deterministic cache path.
        const extractSpinner = print.spin(`Extracting cloakmail ${version}...`)
        try {
          const tmpExtract = await filesystem.tmpDir({ prefix: "cloakmail-extract-" })
          await extractTarballToDir(tarballPath, tmpExtract, version)

          const children = await filesystem.list(tmpExtract)
          const firstChild = children[0]
          if (!firstChild) {
            throw new AcquireError(`Extracted cloakmail tarball is empty (${tarballPath})`, version)
          }
          const extractedRoot = filesystem.path.join(tmpExtract, firstChild)

          // Move the extracted root into the cache. We use copy + remove rather
          // than `move` because `move` across filesystems can fail with EXDEV
          // and the temp dir lives on the system temp partition.
          await filesystem.copy(extractedRoot, extractedDir, { overwrite: true })
          await filesystem.remove(tmpExtract)
          await filesystem.remove(tarballPath)

          const manifest = await readManifest(extractedDir)
          assertCompatible(manifest, version)
          state.path = extractedDir
          state.manifest = manifest
          state.version = version
          extractSpinner.succeed(`Acquired cloakmail ${version} at ${extractedDir}`)
          return { root: extractedDir, manifest, version }
        } catch (err) {
          extractSpinner.fail(`Failed to extract cloakmail ${version}`)
          throw err
        }
      },
    }
  },
})
