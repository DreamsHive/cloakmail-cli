/**
 * CLI banner — printed at the top of every cloakmail-cli invocation.
 *
 * The ASCII art is hand-rolled "ANSI Shadow" style — the same font you get
 * from `figlet -f "ANSI Shadow" CLOAKMAIL`. We embed it as a static string
 * rather than depending on figlet at runtime so the banner has zero deps
 * and zero startup cost.
 *
 * Display rules:
 *   - Printed in cyan via raw ANSI escapes (no `seed.print.colors` because
 *     we want to fire BEFORE the seedcli runtime initializes)
 *   - Suppressed when stdout is not a TTY (CI logs, piped output, etc.)
 *     so scripts can still parse `--version` cleanly
 *   - Suppressed when the user passes `--no-banner` (escape hatch)
 */

const BANNER = ` ██████╗██╗      ██████╗  █████╗ ██╗  ██╗███╗   ███╗ █████╗ ██╗██╗
██╔════╝██║     ██╔═══██╗██╔══██╗██║ ██╔╝████╗ ████║██╔══██╗██║██║
██║     ██║     ██║   ██║███████║█████╔╝ ██╔████╔██║███████║██║██║
██║     ██║     ██║   ██║██╔══██║██╔═██╗ ██║╚██╔╝██║██╔══██║██║██║
╚██████╗███████╗╚██████╔╝██║  ██║██║  ██╗██║ ╚═╝ ██║██║  ██║██║███████╗
 ╚═════╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝╚══════╝`

const TAGLINE = "                     Self-hosted disposable email"

// Raw ANSI escape codes — we can't use seedcli's `print.colors` here
// because the banner fires before the runtime is built.
//
// LOGO color is `oklch(85.2% 0.199 91.936)` — Tailwind's `yellow-400`,
// which converts to `rgb(250, 204, 21)` / `#facc15`. Modern terminals
// (iTerm2, Terminal.app, VS Code, Warp, kitty, wezterm, Windows Terminal)
// all support 24-bit truecolor, so we encode it directly via the
// `\x1b[38;2;R;G;Bm` sequence. Older terminals fall back gracefully —
// they just see the raw escape and either render the closest 256-color
// match or strip it.
const LOGO = "\x1b[38;2;250;204;21m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

/**
 * Print the cloakmail-cli banner to stdout.
 *
 * No-op when:
 *   - stdout is not a TTY (CI logs, piped to a file, etc.)
 *   - argv contains `--no-banner`
 *   - the `CLOAKMAIL_CLI_NO_BANNER` env var is set
 */
export function printBanner(): void {
  if (process.stdout.isTTY !== true) return
  if (process.argv.includes("--no-banner")) return
  if (process.env.CLOAKMAIL_CLI_NO_BANNER) return

  // newline before so the banner has a little breathing room from any
  // previous prompt; newline after so command output starts on a fresh line
  process.stdout.write("\n")
  process.stdout.write(`${LOGO}${BANNER}${RESET}\n`)
  process.stdout.write(`${DIM}${TAGLINE}${RESET}\n`)
  process.stdout.write("\n")
}
