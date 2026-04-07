/**
 * `{{KEY}}` template substitution.
 *
 * The cloakmail repo's `wrangler.toml.template` files use Mustache-style
 * `{{PLACEHOLDER}}` markers. `seed.template.renderString` is Eta-based
 * (`<%= it.name %>`) and not compatible. `seed.strings.template` *does*
 * support `{{key}}` syntax but it's case-sensitive on the variable names —
 * since our placeholders are uppercase (`{{API_WORKER_NAME}}`) and our
 * call-site convention matches them exactly, that works.
 *
 * We still hand-roll a tiny regex-based renderer here so the behavior is
 * predictable, dependency-free, and we can preserve unrecognized placeholders
 * verbatim instead of replacing them with the empty string. That makes
 * "missing var" failures show up clearly in the rendered output during
 * tests instead of silently producing a half-empty toml.
 */

/**
 * Replace every `{{KEY}}` occurrence in `template` with the matching value
 * from `vars`. Unknown keys are left untouched (returned as `{{KEY}}`).
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = vars[key]
    return value !== undefined ? value : match
  })
}
