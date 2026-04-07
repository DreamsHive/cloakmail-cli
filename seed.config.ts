import { defineConfig } from "@seedcli/core"

export default defineConfig({
  // Development server options
  dev: {
    entry: "src/index.ts",
    clearScreen: true,
  },

  // Build configuration — used by `bun run build` before `npm publish`.
  // seedcli's build step auto-converts `.src()` auto-discovery into static
  // imports so the bundled output works in any ESM runtime, not just Bun's
  // filesystem-scanning dev mode. We ship the bundled `dist/` to npm (see
  // `package.json` -> `files`, `bin`), not the raw source.
  //
  // NOTE: we publish as a regular npm package, NOT a standalone binary, so
  // only the `bundle` block is configured — no `compile` targets.
  build: {
    entry: "src/index.ts",
    bundle: {
      outdir: "dist",
      minify: true,
      // Sourcemaps intentionally disabled for the published tarball — they'd
      // quadruple the package size (45 KB bundle vs ~230 KB with a map) for
      // a marginal win. Stack traces from user reports land on minified
      // column offsets, but we reproduce crashes locally against `src/` where
      // the unminified source + tsc already give us everything we need.
      sourcemap: false,
    },
    // Keep runtime dependencies external — they'll be installed from npm
    // alongside the published package and resolved at runtime. Bundling
    // them would balloon the tarball and try to inline native .node binaries
    // that rolldown can't read (fsevents being the classic offender).
    external: [
      // Our direct dependencies — stay external, resolved via node_modules
      "@seedcli/core",
      "wrangler",
      // macOS-only native file watcher, pulled in transitively and unloadable
      // by the bundler because it imports a .node binary
      "fsevents",
    ],
  },
})
