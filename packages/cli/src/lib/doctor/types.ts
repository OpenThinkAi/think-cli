/**
 * The shared vocabulary of `think doctor` (AGT-1308).
 *
 * A check is a plain exported function that takes every input it needs by
 * injection — paths, platform, a clock, a probe, the building block it
 * reports on — and returns one `CheckResult`. Nothing here reads the real
 * home, opens a socket, or touches the network on its own; the production
 * defaults are wired in `registry.ts` and only there.
 *
 * Two rules the design doc makes load-bearing, and that every check in this
 * directory keeps:
 *
 *  - **A check never sends cortex content anywhere.** The LLM check is a
 *    liveness probe against a configured endpoint and carries no prompt, no
 *    memory text, no file contents (AC5).
 *  - **A check never writes.** Reporting is read-only; the repairs live in
 *    `registry.ts` behind `--fix`, and each one is a function self-heal
 *    already calls (AC4), never a second implementation.
 */

/**
 * `pass` — nothing to do.
 * `warn` — worth a human's attention but the install works; does not fail the
 *          exit code, so `--json` consumers gating a setup script on
 *          `think doctor` are not blocked by, say, a second think home.
 * `fail` — broken or actively harmful; exit code 1 (AC2).
 */
export type CheckStatus = 'pass' | 'warn' | 'fail';

/** One line of `think doctor` output, and one object of `--json` (AC2). */
export interface CheckResult {
  /** Stable machine-readable id. Also the `--fix` registry key. */
  id: string;
  status: CheckStatus;
  /** One line, human-readable. Always populated, including on `pass`. */
  detail: string;
  /**
   * Whether `think doctor --fix` can repair THIS result. False on a `pass`
   * (nothing to fix) and false for anything whose remedy needs a human
   * decision — a missing hook entry, an unreachable provider, a second think
   * home. `--fix` runs a repair only for a non-pass result with `fixable:
   * true`, so a check can report a problem without implying a safe repair.
   */
  fixable: boolean;
}

/** Convenience constructor, so each check reads as its logic and not as
 *  object literals. */
export function result(
  id: string,
  status: CheckStatus,
  detail: string,
  fixable = false,
): CheckResult {
  // A passing check is never "fixable" — there is nothing to repair, and
  // letting one through would make `--fix` act on a healthy machine.
  return { id, status, detail, fixable: status === 'pass' ? false : fixable };
}

/** Pluralize a count for a detail line: `1 agent`, `3 agents`. */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}
