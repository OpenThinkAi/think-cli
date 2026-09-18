/**
 * Check: retired vocabulary in unmanaged instruction files (think-3 design
 * doc, "Prune"; AGT-1309).
 *
 * Hand-written or pre-marker instruction text keeps teaching commands and
 * flags the v3 architecture removed — `--decision`, `--episode`, the
 * non-retro `think curate`, `think log`, `think monitor`, `--engrams`, and
 * the underlying "engram" concept. A managed block gets refreshed on
 * `think update` (AGT-1306), but the hand-written prose around it — and
 * files think never wrote a block into at all, like a Studio's
 * `~/.claude/CLAUDE.md` — does not.
 *
 * This check only READS. It never edits these files, with or without
 * `--fix` (AC3): the fix for a stale sentence in someone's CLAUDE.md is the
 * owner's call, not something a machine should silently rewrite. It always
 * reports `fixable: false` and `warn` (never `fail`) — dead vocabulary in a
 * hand-written file is guidance debt, not a broken install.
 *
 * `RETIRED_VOCABULARY_TERMS` is exported so AGT-1315's markdown lint can
 * share the exact same term list and replacement text (AC4) rather than
 * maintaining a second copy that drifts from this one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globalSettingsPath } from '../claude-settings.js';
import { listRegisteredBlocks } from '../block-registry.js';
import { WORKLOG_UPSERT, RETRO_UPSERT } from '../../commands/init.js';
import { stripControls } from '../sanitize.js';
import { result, plural, type CheckResult } from './types.js';

export const RETIRED_VOCABULARY_CHECK_ID = 'retired-vocabulary';

/** One retired term this check looks for, and what to say instead. */
export interface RetiredVocabularyTerm {
  /** Display name for the term. */
  term: string;
  /**
   * Matches the term as it appears in prose. Word-bounded so it doesn't fire
   * on a longer word (`engrammatic`) or a still-live sibling
   * (`think curate-retros`, `think logs`). Must carry the `g` flag — the
   * scanner calls `.exec()` in a loop over each line.
   */
  pattern: RegExp;
  /** What to tell the file's owner to write instead. */
  replacement: string;
}

/**
 * The shared term list (AC4). Order matters: a line's characters are
 * "claimed" by the first term that matches them, so `--engrams` and the
 * generic `engram` term below it never both report the same four
 * characters — the specific flag wins over the generic noun.
 */
export const RETIRED_VOCABULARY_TERMS: RetiredVocabularyTerm[] = [
  {
    term: '--decision',
    pattern: /--decision\b/g,
    replacement: 'think event "Decided …"',
  },
  {
    term: '--episode',
    pattern: /--episode\b/g,
    replacement: 'removed — episodes are gone; use think event / think memory',
  },
  {
    term: 'think curate',
    // Excludes `think curate-retros`, which is still live (retro curation
    // never touched engrams and stays).
    pattern: /think curate\b(?!-retros)/g,
    replacement: 'removed (retro curation is `think curate-retros`)',
  },
  {
    term: 'think log',
    // `\b` after "log" already excludes "think logs"-style words — "s" is a
    // word character, so no boundary falls between "log" and "logs".
    pattern: /think log\b/g,
    replacement: 'removed — use `think sync`',
  },
  {
    term: 'think monitor',
    pattern: /think monitor\b/g,
    replacement: 'removed — there is no engram tier left to monitor',
  },
  {
    term: '--engrams',
    pattern: /--engrams\b/g,
    replacement: 'removed (recall searches memories)',
  },
  {
    term: 'engram',
    pattern: /engrams?\b/gi,
    replacement: 'memory/event',
  },
];

/** A single retired-vocabulary hit, before it is formatted into a line. */
interface Hit {
  file: string;
  line: number;
  text: string;
  replacement: string;
}

export interface RetiredVocabularyOptions {
  /** Home directory to resolve `~/CLAUDE.md`, `~/AGENTS.md`, `~/.codex/AGENTS.md` against. Tests MUST inject a temp dir. */
  homeDir?: string;
  /** Absolute path of `$CLAUDE_CONFIG_DIR/CLAUDE.md` (or `~/.claude/CLAUDE.md` when unset). Tests MUST inject a temp path. */
  claudeMdPath?: string;
  /** Every other file to scan, beyond the fixed set. Production default is AGT-1305's registry. */
  registeredFiles?: string[];
  /** Terms to scan for. Seam for tests; production default is the shared list above. */
  terms?: RetiredVocabularyTerm[];
}

export function checkRetiredVocabulary(options: RetiredVocabularyOptions = {}): CheckResult {
  const homeDir = options.homeDir ?? os.homedir();
  // `globalSettingsPath()` already resolves `$CLAUDE_CONFIG_DIR` vs.
  // `~/.claude` (claude-settings.ts) — reuse it rather than re-deriving the
  // same env-var precedence a second time.
  const claudeMdPath = options.claudeMdPath ?? path.join(path.dirname(globalSettingsPath()), 'CLAUDE.md');
  const registeredFiles = options.registeredFiles ?? listRegisteredBlocks().map((entry) => entry.path);
  const terms = options.terms ?? RETIRED_VOCABULARY_TERMS;

  const fixedFiles = [
    path.join(homeDir, 'CLAUDE.md'),
    path.join(homeDir, 'AGENTS.md'),
    claudeMdPath,
    path.join(homeDir, '.codex', 'AGENTS.md'),
  ];

  // Dedupe: a registered file may also be one of the fixed paths.
  const files = [...new Set([...fixedFiles, ...registeredFiles].map((f) => path.resolve(f)))].sort();

  const hits: Hit[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue; // Missing files are silently skipped (AC1).
    }
    hits.push(...scanFile(file, content, terms));
  }

  if (hits.length === 0) {
    return result(
      RETIRED_VOCABULARY_CHECK_ID,
      'pass',
      'No retired vocabulary found outside managed markers.',
    );
  }

  // Warn, never fail (AC2 wording: "status is warn") — and never fixable
  // (AC3): rewriting someone's hand-written instructions is not a repair
  // `--fix` should ever attempt.
  return result(
    RETIRED_VOCABULARY_CHECK_ID,
    'warn',
    `${plural(hits.length, 'retired term')} found outside managed markers:\n${hits.map(formatHit).join('\n')}`,
    false,
  );
}

const MAX_LINE_DISPLAY = 160;

/** `file:line: <matched text>  ->  <replacement>`, truncated and sanitized. */
function formatHit(hit: Hit): string {
  const cleaned = stripControls(hit.text).trim();
  const display = cleaned.length > MAX_LINE_DISPLAY ? `${cleaned.slice(0, MAX_LINE_DISPLAY)}…` : cleaned;
  return `${hit.file}:${hit.line}: ${display}  ->  ${hit.replacement}`;
}

/**
 * Scan one file's content for every term, skipping lines that fall inside a
 * managed block (either kind — AC1 "outside managed markers"). The begin/end
 * markers are each a whole line on their own (see init.ts's template
 * builders), so a simple line-by-line state machine is enough: no need to
 * reason about byte offsets the way `block-registry.ts` does for a single
 * marker pair.
 */
function scanFile(file: string, content: string, terms: RetiredVocabularyTerm[]): Hit[] {
  const lines = content.split('\n');
  const hits: Hit[] = [];
  const openers = [WORKLOG_UPSERT, RETRO_UPSERT];
  let activeEndMarker: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (activeEndMarker !== null) {
      if (line.includes(activeEndMarker)) activeEndMarker = null;
      continue; // The begin/end marker lines themselves are also skipped.
    }

    const opener = openers.find((upsert) => line.includes(upsert.beginMarker));
    if (opener) {
      activeEndMarker = opener.endMarker;
      continue;
    }

    // Claim ranges within this line so a more specific term (`--engrams`)
    // and a broader one below it (`engram`) never both report the same
    // characters.
    const claimed: Array<[number, number]> = [];
    for (const term of terms) {
      term.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = term.pattern.exec(line)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (claimed.some(([s, e]) => start < e && end > s)) {
          if (match[0].length === 0) term.pattern.lastIndex++; // guard against zero-width loops
          continue;
        }
        claimed.push([start, end]);
        hits.push({ file, line: i + 1, text: line, replacement: term.replacement });
      }
    }
  }

  return hits;
}
