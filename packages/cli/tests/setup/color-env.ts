/**
 * #96 — the suite's single colour-env choke point.
 *
 * Wired as vitest `setupFiles`, so this runs in every worker BEFORE any test
 * module (and so before chalk, which reads the environment once at import
 * time) is loaded.
 *
 * Why this exists: many tests assert exact CLI output strings. Chalk honours
 * FORCE_COLOR ahead of TTY detection and NO_COLOR, so a caller shell that
 * exports FORCE_COLOR (agent and job shells commonly set FORCE_COLOR=3, and
 * `stamp merge` runs the required checks in the caller's env) turned those
 * strings into ANSI-escaped ones and failed an otherwise green suite.
 *
 * FORCE_COLOR=0 is chalk's explicit "no colour" — it wins over TTY detection,
 * so output is plain whether the suite runs in a terminal, a pipe, or a merge
 * gate. It is also inherited by any CLI subprocess a test spawns with
 * `{ ...process.env }`.
 *
 * Test infrastructure only: production colour behaviour is untouched. A test
 * that genuinely needs colour can still set chalk.level locally.
 */

process.env.FORCE_COLOR = '0';
