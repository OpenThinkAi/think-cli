/**
 * Working-context detection — iterative-learning v3 (retro locality).
 *
 * A retro is stored on the user's home/active cortex and *tagged* with the
 * context it is about. The context is the basename of the git repository the
 * command was run in — the same convention `think init` already uses to infer a
 * cortex name (`basename "$(git rev-parse --show-toplevel)"`), promoted here
 * from "a string the agent is told to type" to "something the CLI computes."
 *
 * The context is encoded as a reserved-prefix topic (`repo:<context>`) so it
 * rides the existing `topics_json` column + recall topic filter (AGT-320)
 * without a schema change, and never collides with user-supplied free topics
 * (`--topic ux`). brief/recall pick it out by the `repo:` prefix.
 *
 * Two independent axes (see docs/iterative-learning-v3-locality.md §2):
 *   - storage cortex = where the row lives (active/home cortex)
 *   - context tag    = what the row is about (this module)
 */

import { execSync } from 'node:child_process';
import path from 'node:path';

/**
 * Reserved topic prefix that encodes a working context. A retro about the
 * `stamp-cli` repo carries the topic `repo:stamp-cli`.
 */
export const CONTEXT_TOPIC_PREFIX = 'repo:';

/**
 * Normalize a raw context name (lowercase, trimmed). Keeps the value stable
 * across case/whitespace differences in directory names. Returns null for an
 * empty/whitespace-only input so callers can treat it as "no context."
 */
export function normalizeContext(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  return v.length > 0 ? v : null;
}

/**
 * Detect the working context = basename of the git toplevel of `cwd`,
 * normalized. Returns null when `cwd` is not inside a git repository (or git is
 * unavailable) — callers then store the retro untagged rather than erroring.
 *
 * `cwd` is injectable for testing; defaults to the process working directory.
 * Mirrors the detection in `commands/init.ts` (resolveRetroDefaultDir) but
 * returns the basename and tolerates a missing repo silently.
 */
export function detectWorkingContext(cwd: string = process.cwd()): string | null {
  let top: string;
  try {
    top = execSync('git rev-parse --show-toplevel', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
  } catch {
    return null;
  }
  if (top.length === 0) return null;
  return normalizeContext(path.basename(top));
}

/**
 * The reserved topic that encodes a context, e.g. `contextTopic("stamp-cli")`
 * → `"repo:stamp-cli"`. Input is normalized first.
 *
 * Callers must pass a non-empty context: an empty/whitespace input yields the
 * bare sentinel `"repo:"`, which is not a usable tag. Every call site guards by
 * resolving the context (`--context` / `detectWorkingContext`) to a non-null
 * value first and skipping the tag entirely when it is null, so this never
 * receives empty input in practice — the `?? ''` is defensive, not a feature.
 */
export function contextTopic(context: string): string {
  const norm = normalizeContext(context);
  return `${CONTEXT_TOPIC_PREFIX}${norm ?? ''}`;
}

/**
 * Extract the context name encoded in a topics array, or null if none carries
 * the `repo:` prefix. Case-insensitive; returns the first match. When multiple
 * `repo:` topics exist (should not happen in normal writes) the first wins.
 */
export function contextFromTopics(topics: readonly string[]): string | null {
  for (const t of topics) {
    if (typeof t !== 'string') continue;
    if (t.toLowerCase().startsWith(CONTEXT_TOPIC_PREFIX)) {
      return normalizeContext(t.slice(CONTEXT_TOPIC_PREFIX.length));
    }
  }
  return null;
}
