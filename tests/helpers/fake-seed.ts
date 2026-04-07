import type { AcquiredSource, CloakmailManifest } from "../../src/extensions/source"
import type { CloakmailState } from "../../src/extensions/state"
import type { SetupFlags, SetupSeed } from "../../src/lib/steps/types"

/**
 * Build a synthetic Seed-shaped object for unit tests.
 *
 * The real seedcli runtime is heavyweight (loads plugins, registers signal
 * handlers, parses argv, etc.) and the testing package's `mockSystem` /
 * `mockHttp` hooks aren't wired into the runtime in 1.1.1 — so we hand-roll
 * a minimal stub that exposes ONLY the modules / extensions each step
 * actually touches. The stub records every call so tests can assert against
 * the recorded interactions instead of relying on stdout scraping.
 *
 * Anything not explicitly stubbed is left as a no-op (print) or throws
 * (filesystem reads of unknown paths) so accidental access surfaces loudly.
 */

export interface FakeSpinner {
  text: string
  isSpinning: boolean
  events: Array<{ kind: "succeed" | "fail" | "warn" | "info" | "stop"; text?: string }>
}

export interface FakePrintCalls {
  info: string[]
  success: string[]
  warning: string[]
  error: string[]
  muted: string[]
  highlight: string[]
  debug: string[]
  box: Array<{ text: string; title?: string }>
  newlineCount: number
  spinners: FakeSpinner[]
}

export interface PromptScript {
  inputs?: string[]
  passwords?: string[]
  confirms?: boolean[]
  selects?: unknown[]
}

export interface FakeStateApi {
  data: CloakmailState
  saves: Array<Partial<CloakmailState>>
  cleared: boolean
  load(): Promise<CloakmailState>
  save(partial: Partial<CloakmailState>): Promise<void>
  recordCreated(partial: Partial<NonNullable<CloakmailState["created_by_wizard"]>>): Promise<void>
  clear(): Promise<void>
  path: string
}

export interface FakeCloudflareApi {
  setToken: (token: string) => void
  verifyToken: () => Promise<{ accountId: string; status: string }>
  checkAccountPrereqs: (
    accountId: string,
  ) => Promise<{ workersSubdomain: string | null; r2Enabled: boolean }>
  listZones: (
    name: string,
  ) => Promise<Array<{ id: string; name: string; status: string; accountId: string }>>
  enableEmailRouting: (zoneId: string) => Promise<void>
  getEmailRouting: (zoneId: string) => Promise<{ enabled: boolean; status: string }>
  pollMxVerified: (zoneId: string, timeoutMs?: number) => Promise<boolean>
  upsertCatchAll: (zoneId: string, workerName: string) => Promise<void>
  bindCustomDomain: (opts: {
    accountId: string
    hostname: string
    serviceName: string
    zoneId: string
  }) => Promise<{ created: boolean; conflictDifferentService?: string }>
  unbindCustomDomain: (opts: { accountId: string; hostname: string }) => Promise<void>
  deleteCatchAll: (zoneId: string) => Promise<void>
  disableEmailRouting: (zoneId: string) => Promise<void>
  deleteWorker: (opts: { accountId: string; scriptName: string }) => Promise<void>
  api: unknown
  /** Override individual methods per-test. */
  overrides?: Partial<{
    verifyToken: FakeCloudflareApi["verifyToken"]
    checkAccountPrereqs: FakeCloudflareApi["checkAccountPrereqs"]
    listZones: FakeCloudflareApi["listZones"]
    enableEmailRouting: FakeCloudflareApi["enableEmailRouting"]
    getEmailRouting: FakeCloudflareApi["getEmailRouting"]
    pollMxVerified: FakeCloudflareApi["pollMxVerified"]
    upsertCatchAll: FakeCloudflareApi["upsertCatchAll"]
    bindCustomDomain: FakeCloudflareApi["bindCustomDomain"]
    unbindCustomDomain: FakeCloudflareApi["unbindCustomDomain"]
    deleteCatchAll: FakeCloudflareApi["deleteCatchAll"]
    disableEmailRouting: FakeCloudflareApi["disableEmailRouting"]
    deleteWorker: FakeCloudflareApi["deleteWorker"]
  }>
  calls: {
    setToken: string[]
    listZones: string[]
    enableEmailRouting: string[]
    pollMxVerified: string[]
    upsertCatchAll: Array<{ zoneId: string; workerName: string }>
    bindCustomDomain: Array<{
      accountId: string
      hostname: string
      serviceName: string
      zoneId: string
    }>
    unbindCustomDomain: Array<{ accountId: string; hostname: string }>
    deleteCatchAll: string[]
    disableEmailRouting: string[]
    deleteWorker: Array<{ accountId: string; scriptName: string }>
  }
}

export interface FakeWranglerApi {
  setToken: (token: string) => void
  setAccountId: (accountId: string) => void
  d1List: () => Promise<Array<{ uuid: string; name: string }>>
  d1Create: (name: string) => Promise<{ uuid: string; name: string }>
  d1MigrationsApply: (name: string, opts: { cwd: string }) => Promise<void>
  d1Delete: (name: string) => Promise<void>
  r2List: () => Promise<Array<{ name: string }>>
  r2Create: (name: string) => Promise<{ created: boolean }>
  r2Delete: (name: string) => Promise<void>
  deploy: (packagePath: string, opts: { cwd: string }) => Promise<{ url: string }>
  workerDelete: (name: string) => Promise<void>
  calls: {
    d1Create: string[]
    d1Delete: string[]
    r2Create: string[]
    r2Delete: string[]
    deploys: string[]
    migrate: string[]
    workerDelete: string[]
  }
}

export interface FakeSourceApi {
  root: string
  manifest?: CloakmailManifest
  acquire: (opts: { from?: string; version?: string }) => Promise<AcquiredSource>
}

export interface BuildFakeSeedOptions {
  flags?: SetupFlags
  state?: Partial<CloakmailState>
  prompts?: PromptScript
  cloudflare?: FakeCloudflareApi["overrides"]
  wrangler?: Partial<FakeWranglerApi>
  source?: Partial<FakeSourceApi>
  http?: {
    head?: () => Promise<unknown>
    get?: (url: string) => Promise<{ status: number; data: unknown }>
  }
  systemWhich?: (binary: string) => string | undefined
  filesystem?: {
    files?: Record<string, string>
    /** Records all writes for assertion. */
  }
}

function makeSpinner(label: string, calls: FakePrintCalls): FakeSpinner {
  const spinner: FakeSpinner = {
    text: label,
    isSpinning: true,
    events: [],
  }
  calls.spinners.push(spinner)
  return spinner
}

export function buildFakeSeed(opts: BuildFakeSeedOptions = {}): {
  seed: SetupSeed
  print: FakePrintCalls
  state: FakeStateApi
  cloudflare: FakeCloudflareApi
  wrangler: FakeWranglerApi
  source: FakeSourceApi
  fs: { writes: Record<string, string> }
} {
  const printCalls: FakePrintCalls = {
    info: [],
    success: [],
    warning: [],
    error: [],
    muted: [],
    highlight: [],
    debug: [],
    box: [],
    newlineCount: 0,
    spinners: [],
  }

  const print = {
    info: (m: string) => {
      printCalls.info.push(m)
    },
    success: (m: string) => {
      printCalls.success.push(m)
    },
    warning: (m: string) => {
      printCalls.warning.push(m)
    },
    error: (m: string) => {
      printCalls.error.push(m)
    },
    muted: (m: string) => {
      printCalls.muted.push(m)
    },
    highlight: (m: string) => {
      printCalls.highlight.push(m)
    },
    debug: (m: string) => {
      printCalls.debug.push(m)
    },
    newline: (count = 1) => {
      printCalls.newlineCount += count
    },
    spin: (label: string) => {
      const sp = makeSpinner(label, printCalls)
      return {
        get text() {
          return sp.text
        },
        set text(v: string) {
          sp.text = v
        },
        get isSpinning() {
          return sp.isSpinning
        },
        succeed(text?: string) {
          sp.events.push({ kind: "succeed", text })
          sp.isSpinning = false
        },
        fail(text?: string) {
          sp.events.push({ kind: "fail", text })
          sp.isSpinning = false
        },
        warn(text?: string) {
          sp.events.push({ kind: "warn", text })
          sp.isSpinning = false
        },
        info(text?: string) {
          sp.events.push({ kind: "info", text })
          sp.isSpinning = false
        },
        stop() {
          sp.events.push({ kind: "stop" })
          sp.isSpinning = false
        },
      }
    },
    box: (text: string, options?: { title?: string }) => {
      printCalls.box.push({ text, title: options?.title })
    },
    table: () => {},
    ascii: () => {},
    tree: () => {},
    keyValue: () => {},
    divider: () => {},
    progressBar: () => ({
      update: () => {},
      done: () => {},
      get current() {
        return 0
      },
    }),
    columns: (items: string[]) => items.join(" "),
    indent: (text: string) => text,
    wrap: (text: string) => text,
    colors: {} as never,
  }

  // -----------------------------------------------------------------
  // State extension
  // -----------------------------------------------------------------
  const stateData: CloakmailState = { ...(opts.state ?? {}) }
  const stateApi: FakeStateApi = {
    path: "/tmp/cloakmail-cli-state.json",
    data: stateData,
    saves: [],
    cleared: false,
    async load() {
      return { ...stateData }
    },
    async save(partial) {
      stateApi.saves.push(partial)
      Object.assign(stateData, partial)
    },
    async recordCreated(partial) {
      // Mirror the real extension: deep-merge into created_by_wizard so
      // multiple steps can append without clobbering each other.
      stateApi.saves.push({ created_by_wizard: partial })
      stateData.created_by_wizard = {
        ...(stateData.created_by_wizard ?? {}),
        ...partial,
      }
    },
    async clear() {
      stateApi.cleared = true
      for (const key of Object.keys(stateData) as Array<keyof CloakmailState>) {
        delete stateData[key]
      }
    },
  }

  // -----------------------------------------------------------------
  // Prompt
  // -----------------------------------------------------------------
  const promptScript = opts.prompts ?? {}
  let inputIdx = 0
  let pwIdx = 0
  let confirmIdx = 0
  let selectIdx = 0
  const prompt = {
    async input({ default: def }: { message: string; default?: string }) {
      const value = promptScript.inputs?.[inputIdx++]
      return value ?? def ?? ""
    },
    async password() {
      const value = promptScript.passwords?.[pwIdx++]
      return value ?? "test-token"
    },
    async confirm({ default: def }: { message: string; default?: boolean }) {
      const value = promptScript.confirms?.[confirmIdx++]
      return value ?? def ?? false
    },
    async select<T>({ default: def }: { message: string; choices: unknown; default?: T }) {
      const value = promptScript.selects?.[selectIdx++]
      return (value ?? def) as T
    },
    async multiselect() {
      return [] as never
    },
    async number() {
      return undefined
    },
    async editor() {
      return ""
    },
    async autocomplete() {
      return undefined as never
    },
    async form() {
      return {} as never
    },
  }

  // -----------------------------------------------------------------
  // Cloudflare extension
  // -----------------------------------------------------------------
  const cfCalls: FakeCloudflareApi["calls"] = {
    setToken: [],
    listZones: [],
    enableEmailRouting: [],
    pollMxVerified: [],
    upsertCatchAll: [],
    bindCustomDomain: [],
    unbindCustomDomain: [],
    deleteCatchAll: [],
    disableEmailRouting: [],
    deleteWorker: [],
  }
  const cf: FakeCloudflareApi = {
    overrides: opts.cloudflare,
    calls: cfCalls,
    api: {},
    setToken(token) {
      cfCalls.setToken.push(token)
    },
    async verifyToken() {
      if (cf.overrides?.verifyToken) return cf.overrides.verifyToken()
      return { accountId: "acct-test", status: "active" }
    },
    async checkAccountPrereqs(accountId) {
      if (cf.overrides?.checkAccountPrereqs) return cf.overrides.checkAccountPrereqs(accountId)
      return { workersSubdomain: "test", r2Enabled: true }
    },
    async listZones(name) {
      cfCalls.listZones.push(name)
      if (cf.overrides?.listZones) return cf.overrides.listZones(name)
      return [{ id: `${name}-id`, name, status: "active", accountId: "acct-test" }]
    },
    async enableEmailRouting(zoneId) {
      cfCalls.enableEmailRouting.push(zoneId)
      if (cf.overrides?.enableEmailRouting) return cf.overrides.enableEmailRouting(zoneId)
    },
    async getEmailRouting(zoneId) {
      if (cf.overrides?.getEmailRouting) return cf.overrides.getEmailRouting(zoneId)
      return { enabled: true, status: "ready" }
    },
    async pollMxVerified(zoneId, timeoutMs) {
      cfCalls.pollMxVerified.push(zoneId)
      if (cf.overrides?.pollMxVerified) return cf.overrides.pollMxVerified(zoneId, timeoutMs)
      return true
    },
    async upsertCatchAll(zoneId, workerName) {
      cfCalls.upsertCatchAll.push({ zoneId, workerName })
      if (cf.overrides?.upsertCatchAll) return cf.overrides.upsertCatchAll(zoneId, workerName)
    },
    async bindCustomDomain(args) {
      cfCalls.bindCustomDomain.push(args)
      if (cf.overrides?.bindCustomDomain) return cf.overrides.bindCustomDomain(args)
      return { created: true }
    },
    async unbindCustomDomain(args) {
      cfCalls.unbindCustomDomain.push(args)
      if (cf.overrides?.unbindCustomDomain) return cf.overrides.unbindCustomDomain(args)
    },
    async deleteCatchAll(zoneId) {
      cfCalls.deleteCatchAll.push(zoneId)
      if (cf.overrides?.deleteCatchAll) return cf.overrides.deleteCatchAll(zoneId)
    },
    async disableEmailRouting(zoneId) {
      cfCalls.disableEmailRouting.push(zoneId)
      if (cf.overrides?.disableEmailRouting) return cf.overrides.disableEmailRouting(zoneId)
    },
    async deleteWorker(args) {
      cfCalls.deleteWorker.push(args)
      if (cf.overrides?.deleteWorker) return cf.overrides.deleteWorker(args)
    },
  }

  // -----------------------------------------------------------------
  // Wrangler extension
  // -----------------------------------------------------------------
  const wranglerCalls: FakeWranglerApi["calls"] = {
    d1Create: [],
    d1Delete: [],
    r2Create: [],
    r2Delete: [],
    deploys: [],
    migrate: [],
    workerDelete: [],
  }
  const wrangler: FakeWranglerApi = {
    calls: wranglerCalls,
    setToken: opts.wrangler?.setToken ?? (() => {}),
    setAccountId: opts.wrangler?.setAccountId ?? (() => {}),
    d1List: opts.wrangler?.d1List ?? (async () => []),
    async d1Create(name) {
      wranglerCalls.d1Create.push(name)
      if (opts.wrangler?.d1Create) return opts.wrangler.d1Create(name)
      return { uuid: `${name}-uuid`, name }
    },
    async d1MigrationsApply(name, args) {
      wranglerCalls.migrate.push(name)
      if (opts.wrangler?.d1MigrationsApply) return opts.wrangler.d1MigrationsApply(name, args)
    },
    async d1Delete(name) {
      wranglerCalls.d1Delete.push(name)
      if (opts.wrangler?.d1Delete) return opts.wrangler.d1Delete(name)
    },
    r2List: opts.wrangler?.r2List ?? (async () => []),
    async r2Create(name) {
      wranglerCalls.r2Create.push(name)
      if (opts.wrangler?.r2Create) return opts.wrangler.r2Create(name)
      return { created: true }
    },
    async r2Delete(name) {
      wranglerCalls.r2Delete.push(name)
      if (opts.wrangler?.r2Delete) return opts.wrangler.r2Delete(name)
    },
    async deploy(packagePath, args) {
      wranglerCalls.deploys.push(packagePath)
      if (opts.wrangler?.deploy) return opts.wrangler.deploy(packagePath, args)
      return { url: `https://${packagePath}.workers.dev` }
    },
    async workerDelete(name) {
      wranglerCalls.workerDelete.push(name)
      if (opts.wrangler?.workerDelete) return opts.wrangler.workerDelete(name)
    },
  }

  // -----------------------------------------------------------------
  // Source extension
  // -----------------------------------------------------------------
  const sourceApi: FakeSourceApi = {
    root: opts.source?.root ?? "",
    manifest: opts.source?.manifest,
    acquire:
      opts.source?.acquire ??
      (async () => {
        throw new Error("source.acquire was called but no fake was provided")
      }),
  }

  // -----------------------------------------------------------------
  // Filesystem (in-memory)
  // -----------------------------------------------------------------
  const files: Record<string, string> = { ...(opts.filesystem?.files ?? {}) }
  const writes: Record<string, string> = {}
  const filesystem = {
    async exists(p: string) {
      return p in files
    },
    async isFile(p: string) {
      return p in files
    },
    async isDirectory(p: string) {
      return Object.keys(files).some((file) => file.startsWith(`${p}/`))
    },
    async read(p: string) {
      const value = files[p]
      if (value === undefined) {
        throw new Error(`fake filesystem: no file at ${p}`)
      }
      return value
    },
    async readJson<T>(p: string) {
      return JSON.parse(await filesystem.read(p)) as T
    },
    async write(p: string, content: string | Buffer) {
      const text = typeof content === "string" ? content : content.toString("utf-8")
      files[p] = text
      writes[p] = text
    },
    async writeJson(p: string, data: unknown) {
      const text = JSON.stringify(data, null, 2)
      files[p] = text
      writes[p] = text
    },
    async ensureDir() {},
    async remove(p: string) {
      delete files[p]
    },
    async copy() {},
    async move() {},
    async rename() {},
    async list() {
      return Object.keys(files)
    },
    async subdirectories() {
      return []
    },
    async tmpDir() {
      return "/tmp/fake"
    },
    async tmpFile() {
      return "/tmp/fake.tmp"
    },
    async stat() {
      return { size: 0, isFile: true, isDirectory: false } as never
    },
    async size() {
      return 0
    },
    async find() {
      return []
    },
    async readBuffer() {
      return Buffer.from("")
    },
    async readToml() {
      return {}
    },
    async readYaml() {
      return {}
    },
    path: {
      resolve: (...segments: string[]) => segments.join("/"),
      join: (...segments: string[]) => segments.join("/"),
      dirname: (p: string) => p.split("/").slice(0, -1).join("/"),
      basename: (p: string) => p.split("/").pop() ?? "",
      ext: (p: string) => {
        const i = p.lastIndexOf(".")
        return i >= 0 ? p.slice(i) : ""
      },
      isAbsolute: (p: string) => p.startsWith("/"),
      relative: (from: string, to: string) => to.replace(`${from}/`, ""),
      normalize: (p: string) => p,
      separator: "/",
      home: () => "/home/test",
      cwd: () => "/cwd",
    },
  }

  // -----------------------------------------------------------------
  // System
  // -----------------------------------------------------------------
  const system = {
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0 }
    },
    shell: {} as never,
    // Default `which` returns a wrangler path for any binary EXCEPT `curl`.
    // The verify step's probe checks `which("curl")` to decide between
    // shelling out to curl vs using seed.http.get — by returning undefined
    // for curl, tests fall through to the fetch path, which is fully
    // mocked in the http stub below. Tests that explicitly want to
    // exercise the curl path can override `systemWhich`.
    which:
      opts.systemWhich ??
      ((binary: string) => (binary === "curl" ? undefined : "/usr/bin/wrangler")),
    whichOrThrow: (binary: string) => {
      const result = system.which(binary)
      if (!result) throw new Error(`not found: ${binary}`)
      return result
    },
    os: () => "macos" as const,
    arch: () => "arm64" as const,
    platform: () => "darwin",
    hostname: () => "test",
    cpus: () => 1,
    uptime: () => 0,
    memory: () => ({ total: 0, free: 0 }),
    open: async () => {},
    env: () => undefined,
    isInteractive: () => false,
  }

  // -----------------------------------------------------------------
  // HTTP
  // -----------------------------------------------------------------
  const http = {
    async head() {
      if (opts.http?.head) return opts.http.head()
      return { status: 200, data: undefined }
    },
    async get(url: string) {
      if (opts.http?.get) return opts.http.get(url)
      return { status: 200, data: { status: "ok" } }
    },
    async post() {
      return { status: 200, data: {} }
    },
    async put() {
      return { status: 200, data: {} }
    },
    async patch() {
      return { status: 200, data: {} }
    },
    async delete() {
      return { status: 200, data: {} }
    },
    create: () => http,
    download: async () => {},
    createOpenAPIClient: () => ({}),
  }

  const seed = {
    args: {} as Record<string, unknown>,
    flags: (opts.flags ?? {}) as SetupFlags,
    parameters: { raw: [], argv: [], command: "setup" },
    print,
    prompt,
    filesystem,
    system,
    http,
    template: {} as never,
    strings: {} as never,
    semver: {} as never,
    packageManager: {} as never,
    config: {} as never,
    patching: {} as never,
    ui: {} as never,
    completions: {} as never,
    state: stateApi,
    cloudflare: cf,
    wrangler,
    source: sourceApi,
    meta: {
      version: "0.1.0",
      commandName: "setup",
      brand: "cloakmail-cli",
      debug: false,
    },
  } as unknown as SetupSeed

  return {
    seed,
    print: printCalls,
    state: stateApi,
    cloudflare: cf,
    wrangler,
    source: sourceApi,
    fs: { writes },
  }
}
