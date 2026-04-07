#!/usr/bin/env node

import { build } from "@seedcli/core"
// Read version directly from our own package.json so the value stays in a
// single source of truth. We can't rely on seedcli's `.version()` auto-detect
// here: at build time `generateBuildEntry` strips `.src(import.meta.dirname)`
// and replaces it with static `.command()` / `.extension()` calls, which
// clears `srcDir` on the runtime config — and seedcli's version auto-detect
// only runs when srcDir is set, so the bundled output would otherwise fall
// back to the `0.0.0` default. Rolldown inlines this JSON at bundle time,
// so there's no runtime file read in the shipped `dist/index.js`.
import pkg from "../package.json" with { type: "json" }
import { printBanner } from "./lib/banner"

// Banner fires before the seedcli runtime so it shows for EVERY invocation:
// `setup`, `destroy`, `--help`, `--version`, no-args. The banner skips itself
// in non-TTY contexts so CI logs and piped output stay clean.
printBanner()

const cli = build("cloakmail-cli")
  .src(import.meta.dirname) // Auto-discovers commands/ and extensions/
  .help()
  .version(pkg.version)
  .debug()
  .create()

await cli.run()
