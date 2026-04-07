import { describe, expect, test } from "vitest"
import {
  defaultApiWorkerName,
  defaultD1Name,
  defaultR2Name,
  defaultWebWorkerName,
  randomWorkerSuffix,
} from "../../src/lib/names"

describe("names", () => {
  test("randomWorkerSuffix returns adjective-noun", () => {
    const suffix = randomWorkerSuffix()
    expect(suffix).toMatch(/^[a-z]+-[a-z]+$/)
  })

  test("default names use the expected prefixes", () => {
    expect(defaultApiWorkerName()).toMatch(/^cloakmail-api-[a-z]+-[a-z]+$/)
    expect(defaultWebWorkerName()).toMatch(/^cloakmail-web-[a-z]+-[a-z]+$/)
    expect(defaultD1Name()).toMatch(/^cloakmail-[a-z]+-[a-z]+$/)
    expect(defaultR2Name()).toMatch(/^cloakmail-bodies-[a-z]+-[a-z]+$/)
  })
})
