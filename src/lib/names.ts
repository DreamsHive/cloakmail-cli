/**
 * Random adjective+noun suffix generator for default Cloudflare resource names.
 *
 * The two wordlists are copied verbatim from
 * `cloakmail/packages/web/src/lib/utils/generateAddress.ts:1-11` so that
 * default worker / D1 / R2 names use the same vocabulary as the in-app
 * random address feature. The two repos are independent so we can't import
 * the source file directly — keep the lists in sync if either side changes.
 *
 * 18 adjectives x 18 nouns = 324 unique combinations, which is more than
 * enough to dodge name collisions when multiple cloakmail instances live
 * in the same Cloudflare account.
 */
const adjectives = [
  "fast",
  "swift",
  "vibrant",
  "silent",
  "shadow",
  "cosmic",
  "bold",
  "dark",
  "bright",
  "clever",
  "lucky",
  "noble",
  "wild",
  "calm",
  "steel",
  "iron",
  "neon",
  "crimson",
] as const

const nouns = [
  "tiger",
  "falcon",
  "wolf",
  "hawk",
  "phantom",
  "viper",
  "raven",
  "storm",
  "blaze",
  "frost",
  "cipher",
  "ghost",
  "knight",
  "spark",
  "ember",
  "orbit",
  "pulse",
  "nexus",
] as const

function pickRandom<T extends readonly unknown[]>(list: T): T[number] {
  return list[Math.floor(Math.random() * list.length)] as T[number]
}

/**
 * Returns a random `{adjective}-{noun}` slug, e.g. `shadow-falcon`.
 */
export function randomWorkerSuffix(): string {
  return `${pickRandom(adjectives)}-${pickRandom(nouns)}`
}

/** Default name for the API worker, e.g. `cloakmail-api-shadow-falcon`. */
export function defaultApiWorkerName(): string {
  return `cloakmail-api-${randomWorkerSuffix()}`
}

/** Default name for the web worker, e.g. `cloakmail-web-shadow-falcon`. */
export function defaultWebWorkerName(): string {
  return `cloakmail-web-${randomWorkerSuffix()}`
}

/** Default name for the D1 database, e.g. `cloakmail-shadow-falcon`. */
export function defaultD1Name(): string {
  return `cloakmail-${randomWorkerSuffix()}`
}

/** Default name for the R2 bucket, e.g. `cloakmail-bodies-shadow-falcon`. */
export function defaultR2Name(): string {
  return `cloakmail-bodies-${randomWorkerSuffix()}`
}
