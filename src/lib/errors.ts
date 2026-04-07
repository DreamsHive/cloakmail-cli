/**
 * Cloudflare REST API error.
 *
 * Wraps non-2xx responses from `seed.cloudflare.api.*` calls with the
 * surrounding context (status code, list of error messages, optional
 * remediation hint) so step-level catch blocks can render actionable output.
 */
export class CfError extends Error {
  readonly status: number
  readonly messages: string[]
  readonly hint?: string

  constructor(status: number, messages: string[], hint?: string) {
    super(messages.length > 0 ? messages.join("; ") : `Cloudflare API error (status ${status})`)
    this.name = "CfError"
    this.status = status
    this.messages = messages
    this.hint = hint
  }
}

/**
 * Wrangler CLI error.
 *
 * Thrown when a spawned `wrangler` invocation exits with a non-zero status.
 * Carries the exit code, captured stderr, and the executed command line so
 * the error message printed to the user includes everything they need to
 * reproduce or report the failure.
 */
export class WranglerError extends Error {
  readonly exitCode: number
  readonly stderr: string
  readonly command: string

  constructor(exitCode: number, stderr: string, command: string) {
    super(`wrangler ${command} failed (exit ${exitCode}): ${stderr.trim()}`)
    this.name = "WranglerError"
    this.exitCode = exitCode
    this.stderr = stderr
    this.command = command
  }
}

/**
 * Source acquisition error.
 *
 * Thrown by the `source` extension when fetching, extracting, or validating
 * the cloakmail tarball/local checkout fails. The optional `version` field
 * lets the caller suggest `--version <other-tag>` in the remediation hint.
 */
export class AcquireError extends Error {
  readonly reason: string
  readonly version?: string

  constructor(reason: string, version?: string) {
    super(reason)
    this.name = "AcquireError"
    this.reason = reason
    this.version = version
  }
}
