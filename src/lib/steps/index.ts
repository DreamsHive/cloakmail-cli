/**
 * Re-export each phase's `run` function under a short alias so the setup
 * command's `run` reads as a flat 9-call pipeline:
 *
 *   await steps.validate(seed)
 *   await steps.prompts(seed)
 *   ...
 *
 * Keeping each phase in its own file makes it easy to unit-test in isolation
 * and to swap implementations later (for example, a `--dry-run` mode that
 * skips deploy/routing/domain).
 */
export { run as validate } from "./01-validate"
export { run as prompts } from "./02-prompts"
export { run as acquire } from "./03-acquire"
export { run as provision } from "./04-provision"
export { run as render } from "./05-render"
export { run as deploy } from "./06-deploy"
export { run as routing } from "./07-routing"
export { run as domain } from "./08-domain"
export { run as verify } from "./09-verify"
