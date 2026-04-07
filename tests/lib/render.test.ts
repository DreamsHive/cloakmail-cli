import { describe, expect, test } from "vitest"
import { renderTemplate } from "../../src/lib/render"

describe("renderTemplate", () => {
  test("substitutes every {{KEY}} marker with the matching value", () => {
    const template = 'name = "{{NAME}}"\nid = "{{ID}}"\n'
    const result = renderTemplate(template, { NAME: "shadow", ID: "abc-123" })
    expect(result).toBe('name = "shadow"\nid = "abc-123"\n')
  })

  test("leaves unrecognized placeholders untouched", () => {
    // We deliberately keep `{{MISSING}}` literal so the user spots a render
    // bug in the diff instead of getting a silently broken toml.
    const result = renderTemplate("a={{KNOWN}} b={{MISSING}}", { KNOWN: "x" })
    expect(result).toBe("a=x b={{MISSING}}")
  })

  test("supports placeholder reuse on the same line", () => {
    const result = renderTemplate("{{X}}-{{X}}-{{X}}", { X: "foo" })
    expect(result).toBe("foo-foo-foo")
  })

  test("ignores placeholders with non-word characters", () => {
    // The render contract is `\w+` only — anything else stays as-is.
    expect(renderTemplate("{{ NAME }}", { NAME: "x" })).toBe("{{ NAME }}")
  })
})
