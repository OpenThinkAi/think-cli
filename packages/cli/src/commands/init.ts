import { execSync } from 'node:child_process';
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import chalk from 'chalk';
import { recordBlockWrite, listRegisteredBlocks, type BlockKind } from '../lib/block-registry.js';

const BEGIN_MARKER = '<!-- think:begin (managed by `think init` — do not edit between markers) -->';
const END_MARKER = '<!-- think:end -->';

const RETRO_BEGIN_MARKER = '<!-- think:retro:begin (managed by `think init --retro` — do not edit between markers) -->';
const RETRO_END_MARKER = '<!-- think:retro:end -->';

// Default work-log template (AGT-1300 / think-3). Before this, `think init`
// probed the daemon socket and wrote one of two templates depending on
// whether it answered — daemon down meant an older block that taught
// `--decision` and `think curate`, both retired write paths. There is now
// exactly one template regardless of daemon reachability, and user-facing
// text doesn't say "v2"/"v3" — it's just think (think-3 design doc,
// decision 5). Recall is implicit via the UserPromptSubmit hook + MCP
// server; writing has three verbs (sync/retro/event, no `--decision` flag).
// The privacy paragraph names what actually leaves the machine: compaction
// and supersession, gated by THINK_LLM_CONSENT for off-machine providers —
// not "the curator", which no longer exists as a write path.
const WORKLOG_BLOCK = `# Work Logging

Context is auto-injected via the UserPromptSubmit hook on every turn (additionalContext field); call the \`think_recall\` MCP tool mid-conversation when you need to drill into a specific topic. You don't need to manually run \`think recall\` unless you want to inspect what's stored.

Three verbs for writing:

- \`think sync "<content>"\` — work stream; kind=memory. Use after shipping a change (commit pushed, PR opened, deploy completed).
- \`think retro "<content>"\` — durable wisdom about a codebase; kind=retro. Use when you notice a convention, invariant, gotcha, or prior decision worth preserving for the next agent in this repo. Text is preserved exactly as written.
- \`think event "<content>"\` — notable thing happened; kind=event. Use for milestones, decisions, incidents. Events accumulate and are never superseded.

\`think sync\` and \`think retro\` store on your home cortex (the active one, or \`-C <name>\`). \`think retro\` auto-tags the lesson with the repo you run it in (a \`repo:<basename>\` context) so \`think brief\` and recall surface it for that codebase — you don't pass a cortex per repo. Override the detected context with \`--context <name>\` when needed.

Log a decision with \`think event\`, not narration inside \`think sync\`:

\`\`\`
think event "Decided against X because Y" --silent
\`\`\`

**Privacy: what leaves the machine.** \`think sync\`, \`think retro\`, and \`think event\` write to your local cortex only — nothing is sent anywhere at write time. Compaction (consolidating near-duplicate memories) and supersession (retro dedupe) later run through the configured LLM provider; an off-machine provider (e.g. Anthropic) is only used once \`THINK_LLM_CONSENT=1\` (or \`cortex.llmConsent\` in \`~/.config/think/config.json\`) grants consent. An on-device provider needs no consent, and nothing leaves the machine.
`;

// `--minimal` template: only explicit shipped outcomes, no decision example,
// no per-verb breakdown. Same vocabulary rules as the default template —
// see the forbidden-vocabulary tests.
const MINIMAL_WORKLOG_BLOCK = `# Work Logging (minimal)

When you ship a change, log the outcome:

\`\`\`
think sync "shipped X" --silent
\`\`\`

That's all. Don't run \`think sync\` for exploration, debugging, decisions that weren't acted on, or anything mid-conversation.

**Privacy: what leaves the machine.** Entries write to your local cortex only — nothing is sent anywhere at write time. Compaction later runs through the configured LLM provider; an off-machine provider needs \`THINK_LLM_CONSENT=1\` (or \`cortex.llmConsent\`) before anything is sent. The minimal template keeps what's logged narrow by design — augment with the default template (\`think init --yes\`) if you want richer logging later.
`;

// Fingerprint that identifies a pre-marker (legacy) think block written by an
// older version of this command. Both substrings come from a retired
// template and are distinctive enough that co-occurrence outside markers is
// the legacy signal.
const LEGACY_FINGERPRINT_A = '**After every commit';
const LEGACY_FINGERPRINT_B = 'think sync';

export function buildBlock(minimal = false): string {
  // Wrap the minimal body in the same begin/end markers as the default path
  // so `upsertBlock` can replace-in-place across re-runs and `--minimal` ↔
  // default switches. Without the markers, every re-invocation would append
  // a fresh block (no marker → no existing-block detection → plain append).
  const body = minimal ? MINIMAL_WORKLOG_BLOCK : WORKLOG_BLOCK;
  return `${BEGIN_MARKER}\n${body}${END_MARKER}\n`;
}

// Interactive disclosure copy for the pre-write confirmation prompt below.
// Exported as data (rather than only printed inline) so tests can assert
// vocabulary/content directly instead of having to drive the TTY prompt
// through readline end-to-end.
export const DISCLOSURE_YELLOW_LINES: readonly string[] = [
  'Heads up: this writes a CLAUDE.md block instructing Claude Code to run `think sync`/`think event` on shipped outcomes and decisions.',
  'Entries write to your local cortex only. Compaction later runs through the configured LLM provider.',
  'An off-machine provider needs `THINK_LLM_CONSENT=1` (or `cortex.llmConsent`) before anything is sent.',
];

export const DISCLOSURE_DIM_LINES: readonly string[] = [
  'This template (the non-minimal default) logs shipped outcomes + decisions, no conversational deliberation.',
  'To skip this prompt: `think init --yes` (this template) or `think init --minimal` (more conservative).',
];

// Pre-write disclosure of the write → compaction/supersession → LLM provider
// data flow for interactive sessions. Returns true if the user confirms;
// false to abort. `--yes` and `--minimal` skip this entirely (non-interactive
// bypass). Non-interactive sessions without a bypass flag refuse with
// an actionable error before printing any disclosure text.
async function promptLoggingConfirmation(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // Refuse before printing the wall of yellow disclosure — script
    // callers should see the actionable error first, not a body of
    // copy that's irrelevant in their context.
    console.error(chalk.red('think init: non-interactive session — pass --yes (default template) or --minimal to skip the disclosure prompt.'));
    return false;
  }

  for (const line of DISCLOSURE_YELLOW_LINES) console.log(chalk.yellow(line));
  console.log();
  for (const line of DISCLOSURE_DIM_LINES) console.log(chalk.dim(line));
  console.log();

  const answer = await prompt(`Write the CLAUDE.md block? [Y/n] `, 'y');
  return /^y(es)?$/i.test(answer.trim());
}

export function buildRetroBlock(cortex: string): string {
  const body = `# Iterative Learning

This repo participates in agentic iterative learning via \`think retro\`. Treat retros as a peer-to-future-agents channel: read what others have left for you, and leave behind what would have helped you.

**Read at task start.** Before any non-trivial task in this repo, run:

\`\`\`
think brief --context ${cortex}
\`\`\`

Use the output to inform the work — prior conventions, invariants, decisions, and gotchas other agents have already learned. (Retros are stored on your home cortex, scoped to the \`${cortex}\` context; \`think brief\` alone also works when you run it inside this repo.)

**Write when you notice something worth remembering.** When you discover a convention, invariant, prior decision, or gotcha another agent would benefit from knowing, run:

\`\`\`
think retro "<observation>" --context ${cortex}
\`\`\`

Loose guidance — you decide when to emit. Examples:

- an undocumented convention you had to figure out
- a missing or stale type contract that blocked work
- a surprising invariant in the code
- a gotcha that looks like a bug but is intentional
- a prior decision worth not re-litigating
`;
  return `${RETRO_BEGIN_MARKER}\n${body}${RETRO_END_MARKER}\n`;
}

export type UpsertResult =
  | { kind: 'created' }
  | { kind: 'replaced' }
  | { kind: 'deduped'; count: number }
  | { kind: 'appended' }
  | { kind: 'migrated'; backupPath: string }
  | { kind: 'unchanged' };

export interface UpsertOptions {
  beginMarker: string;
  endMarker: string;
  legacyMigration?: {
    fingerprintA: string;
    fingerprintB: string;
    heading: string;
  };
}

/**
 * Find every *unambiguous* begin/end marker pair in `content`, in order.
 * "Unambiguous" means a BEGIN immediately followed — with no other BEGIN in
 * between — by an END. Collection stops the moment that shape breaks:
 *
 *   - a BEGIN with no END anywhere after it (a stray, unclosed marker), or
 *   - a second BEGIN appearing before the END that would close the first
 *     (nested/interleaved markers — we can't tell which END belongs to
 *     which BEGIN).
 *
 * In either case nothing found from that point on is reported, and
 * upsertBlock falls back to append/legacy-migration for the file (AGT-1305:
 * decide conservatively — never guess that a far-away END closes a stray
 * BEGIN and delete whatever hand-written text sits between them).
 */
function findCleanMarkerPairs(
  content: string,
  beginMarker: string,
  endMarker: string,
): Array<{ start: number; end: number }> {
  const pairs: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (;;) {
    const beginIdx = content.indexOf(beginMarker, cursor);
    if (beginIdx === -1) break;
    const searchFrom = beginIdx + beginMarker.length;
    const endIdx = content.indexOf(endMarker, searchFrom);
    if (endIdx === -1) break; // stray BEGIN, nothing closes it.
    const nextBeginIdx = content.indexOf(beginMarker, searchFrom);
    if (nextBeginIdx !== -1 && nextBeginIdx < endIdx) break; // ambiguous nesting.
    pairs.push({ start: beginIdx, end: endIdx + endMarker.length });
    cursor = endIdx + endMarker.length;
  }
  return pairs;
}

export function upsertBlock(filePath: string, block: string, opts: UpsertOptions): UpsertResult {
  const { beginMarker, endMarker, legacyMigration } = opts;

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, block, 'utf-8');
    return { kind: 'created' };
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  const pairs = findCleanMarkerPairs(existing, beginMarker, endMarker);

  if (pairs.length > 0) {
    const first = pairs[0];
    const last = pairs[pairs.length - 1];
    const before = existing.slice(0, first.start);
    const afterStart = last.end;
    // Drop a single trailing newline after the last END marker so the
    // replacement (which itself ends in "\n") doesn't compound blank lines
    // on every run. Everything strictly between the first BEGIN and the
    // last END — including, when there was more than one pair, whatever
    // sat between the duplicates — is replaced by the single new block;
    // only text outside the outermost pair is preserved byte-for-byte.
    const after = existing.slice(existing[afterStart] === '\n' ? afterStart + 1 : afterStart);
    const next = before + block + after;
    if (next === existing) return { kind: 'unchanged' };
    fs.writeFileSync(filePath, next, 'utf-8');
    return pairs.length > 1 ? { kind: 'deduped', count: pairs.length } : { kind: 'replaced' };
  }

  // No markers — check for a legacy unscoped block to migrate in place
  // (only enabled for the work-log path; retro path is greenfield).
  if (
    legacyMigration &&
    existing.includes(legacyMigration.fingerprintA) &&
    existing.includes(legacyMigration.fingerprintB)
  ) {
    const headingIdx = existing.indexOf(legacyMigration.heading);
    if (headingIdx !== -1) {
      // Slice from the heading to the next H1 (or EOF). The legacy block was
      // always emitted as the trailing section of the file, so this matches
      // either case correctly.
      const tail = existing.slice(headingIdx);
      const nextHeadingRel = tail.search(/\n# /);
      const blockEnd = nextHeadingRel === -1 ? existing.length : headingIdx + nextHeadingRel + 1;
      const before = existing.slice(0, headingIdx).replace(/\n+$/, '\n');
      const after = existing.slice(blockEnd).replace(/^\n+/, '');
      const next = before + block + (after ? '\n' + after : '');
      // Cheap insurance: stash the pre-migration file alongside so any
      // hand-edits that get caught by the fingerprint heuristic are
      // recoverable without leaning on git.
      const backupPath = filePath + '.think-backup';
      fs.writeFileSync(backupPath, existing, 'utf-8');
      fs.writeFileSync(filePath, next, 'utf-8');
      return { kind: 'migrated', backupPath };
    }
  }

  // Plain append (no markers, no legacy block).
  const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(filePath, existing + separator + block, 'utf-8');
  return { kind: 'appended' };
}

// Exported so lib/block-refresh.ts (AGT-1306) can rebuild a registered block
// from the CURRENT template without duplicating the marker constants or the
// legacy-migration rule.
export const WORKLOG_UPSERT: UpsertOptions = {
  beginMarker: BEGIN_MARKER,
  endMarker: END_MARKER,
  legacyMigration: {
    fingerprintA: LEGACY_FINGERPRINT_A,
    fingerprintB: LEGACY_FINGERPRINT_B,
    heading: '# Work Logging',
  },
};

export const RETRO_UPSERT: UpsertOptions = {
  beginMarker: RETRO_BEGIN_MARKER,
  endMarker: RETRO_END_MARKER,
};

function resolveRetroDefaultDir(): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
  } catch {
    return null;
  }
}

function prompt(question: string, defaultValue: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

function reportResult(filePath: string, result: UpsertResult, label: string): void {
  switch (result.kind) {
    case 'created':
      console.log(chalk.green('✓') + ` Created ${filePath} with ${label} instructions`);
      break;
    case 'replaced':
      console.log(chalk.green('✓') + ` Updated ${label} block in ${filePath}`);
      break;
    case 'deduped':
      console.log(
        chalk.green('✓') +
          ` Found ${result.count} copies of the ${label} block in ${filePath} — collapsed to one`,
      );
      break;
    case 'appended':
      console.log(chalk.green('✓') + ` Appended ${label} instructions to ${filePath}`);
      break;
    case 'migrated':
      console.log(
        chalk.green('✓') +
          ` Migrated legacy ${label} block in ${filePath} → scoped markers. Pre-migration copy saved to ${result.backupPath}; review the diff if you had local edits.`,
      );
      break;
    case 'unchanged':
      console.log(chalk.dim(`${filePath} already up to date.`));
      break;
  }
}

export const initCommand = new Command('init')
  .description(
    'Set up Claude Code integration: upserts a marker-bracketed block in CLAUDE.md (and AGENTS.md if present) with work-logging guidance and generic iterative-learning instructions (read via `think brief`, write via `think retro`, cortex inferred from the repo basename). Pass --retro --cortex <name> to upsert a *separate* repo-scoped block that bakes the cortex name into the read/write commands literally — both blocks can coexist in the same file.',
  )
  .option('-d, --dir <path>', 'Target directory for CLAUDE.md')
  .option('-y, --yes', 'Skip confirmation, use defaults')
  .option('--minimal', 'Write a conservative work-log template that logs only explicit shipped outcomes — no decision narration, no retro pattern. Skips the disclosure prompt. Mutually exclusive with --retro.')
  .option('--retro', 'Upsert the iterative-learning (retro) block instead of the work-logging block. Requires --cortex. When no -d is given: writes silently to the git repo root if inside a repo; prompts with cwd as the default otherwise.')
  .option('--cortex <name>', 'Cortex name baked into the retro block commands (required with --retro).')
  .option('--block-version <ver>', 'Removed in 3.0.0. Use `think init` without this flag.')
  .option('--list', 'List every file with a registered managed block, and exit. Ignores all other flags.')
  .addHelpText('after', `
Modes:
  Default (no --retro):
    Manages a single block in CLAUDE.md (and AGENTS.md if present)
    containing work-logging guidance plus generic retro pattern
    instructions (read with \`think brief\`, write with \`think retro\`,
    cortex inferred from the repo's root basename). Best installed once at
    workspace level.

  --retro --cortex <name>:
    Manages a *separate* second block scoped to one cortex. The default
    block teaches the pattern; this one bakes the specific cortex name
    into the read/write commands literally so agents don't have to infer
    it. Both managed blocks coexist independently in the same file —
    install the default block at workspace level, then run --retro at
    each repo root for the cortex-specific commands.

    Target directory when no -d is given:
    - Inside a git repo: writes to the git repo root silently (no prompt).
    - Outside a git repo: prompts with cwd as the seeded default (--yes
      skips the prompt and uses cwd directly).

Examples:
  think init                              # work-log block in ~/CLAUDE.md
  think init --dir . --yes                # work-log block in ./CLAUDE.md
  think init --retro --cortex fx-tracker  # retro block at git root (silent)
  think init --dir . --retro --cortex my-repo  # retro block in ./CLAUDE.md
  think init --list                       # print files with a registered managed block
`)
  .action(async function (this: Command, opts: { dir?: string; yes?: boolean; minimal?: boolean; retro?: boolean; cortex?: string; blockVersion?: string; list?: boolean }) {
    // --list is a standalone query mode: print the registry and exit before
    // any of the write-path option validation below, since it's meaningful
    // with no other flags at all (and combining it with e.g. --retro would
    // otherwise force the --cortex requirement for a call that writes nothing).
    if (opts.list) {
      const entries = listRegisteredBlocks();
      if (entries.length === 0) {
        console.log(chalk.dim('No managed blocks registered.'));
        return;
      }
      console.log('Registered managed blocks:');
      for (const entry of entries) {
        console.log(`  ${chalk.cyan(entry.kind.padEnd(8))} ${entry.path}`);
      }
      return;
    }

    // --block-version was removed in 3.0.0 (AGT-1300 / think-3 design doc
    // decision 5): think init no longer probes the daemon and there is
    // exactly one non-minimal template, so there is nothing left to select.
    // The flag stays declared as an option above only so it reaches this
    // check and gets a one-line, actionable note — an undeclared option
    // would instead hit commander's generic "unknown option" error.
    if (opts.blockVersion !== undefined) {
      console.error(chalk.red('think init: --block-version was removed in 3.0.0 — think init now writes a single template.'));
      process.exit(1);
    }

    // The program declares a global `-C, --cortex <name>` option which shadows
    // the subcommand-local `--cortex` when invoked through the full CLI. Fall
    // back to the global so both `think -C foo init --retro` and
    // `think init --retro --cortex foo` resolve to the same value.
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const cortex = opts.cortex ?? globalOpts.cortex;

    if (opts.minimal && opts.retro) {
      console.error(chalk.red('think init: --minimal and --retro are mutually exclusive (one writes the work-log block, the other writes the retro block).'));
      process.exit(1);
    }

    if (opts.retro && !cortex) {
      console.error(chalk.red('think init --retro: --cortex <name> is required.'));
      console.error(
        chalk.red('The retro block bakes the cortex name into the read/write commands literally; without it the block has no scope.'),
      );
      console.error(chalk.red('Pass it as: think init --retro --cortex <name>'));
      process.exit(1);
    }

    if (cortex && !opts.retro) {
      console.error(chalk.red('think init: --cortex is only meaningful with --retro.'));
      process.exit(1);
    }

    const home = process.env.HOME!;
    const defaultDir = home;

    let targetDir: string;

    if (opts.dir) {
      targetDir = path.resolve(opts.dir);
    } else if (opts.retro) {
      // --retro without -d: use git toplevel silently (in-repo is the 99% case);
      // fall back to a cwd-seeded prompt (or cwd directly with --yes) when not
      // inside a git repo, since the outside-a-repo destination is ambiguous.
      const gitTop = resolveRetroDefaultDir();
      if (gitTop !== null) {
        targetDir = gitTop;
      } else if (opts.yes) {
        targetDir = process.cwd();
      } else {
        const cwd = process.cwd();
        targetDir = await prompt(
          `Where should CLAUDE.md be written? ${chalk.dim(`(${cwd})`)} `,
          cwd,
        );
        targetDir = targetDir.replace(/^~/, home);
        targetDir = path.resolve(targetDir);
      }
    } else if (opts.yes) {
      targetDir = defaultDir;
    } else {
      targetDir = await prompt(
        `Where should CLAUDE.md be written? ${chalk.dim(`(${defaultDir})`)} `,
        defaultDir,
      );
      targetDir = targetDir.replace(/^~/, home);
      targetDir = path.resolve(targetDir);
    }

    if (!fs.existsSync(targetDir)) {
      console.error(chalk.red(`Directory does not exist: ${targetDir}`));
      process.exit(1);
    }

    if (opts.retro) {
      const block = buildRetroBlock(cortex!);
      const label = 'iterative learning';
      const kind: BlockKind = 'retro';

      const claudePath = path.join(targetDir, 'CLAUDE.md');
      reportResult(claudePath, upsertBlock(claudePath, block, RETRO_UPSERT), label);
      recordBlockWrite(claudePath, kind, RETRO_UPSERT.beginMarker, RETRO_UPSERT.endMarker);

      const agentsPath = path.join(targetDir, 'AGENTS.md');
      if (fs.existsSync(agentsPath)) {
        reportResult(agentsPath, upsertBlock(agentsPath, block, RETRO_UPSERT), label);
        recordBlockWrite(agentsPath, kind, RETRO_UPSERT.beginMarker, RETRO_UPSERT.endMarker);
      }

      console.log(
        chalk.dim(
          `  Agents in this directory will now read \`think brief --cortex ${cortex}\` at task start and emit retros to the same cortex.`,
        ),
      );
      return;
    }

    // Pre-write disclosure prompt unless suppressed by --yes (default
    // template, no prompt) or --minimal (minimal template, no prompt).
    // The prompt names the data flow and bails on a No without writing
    // anything. `--retro` writes its own (separate) block and does NOT
    // get this disclosure today — retro-block setup is run per-repo and
    // may be invoked programmatically by repo-setup automation; adding
    // interactive friction there would block those flows. The retro
    // path's own data flow disclosure lives in SECURITY.md
    // "Per-curation data envelope" + retro-recall docs.
    if (!opts.yes && !opts.minimal) {
      const proceed = await promptLoggingConfirmation();
      if (!proceed) {
        // The user said no — that's an explicit choice, not a failure.
        // Dim text + exit 1 lets scripts branch on the exit code without
        // the message reading like an error to the human.
        console.log(chalk.dim('think init: aborted; no file written.'));
        process.exit(1);
      }
    }

    const block = buildBlock(opts.minimal);
    const label = opts.minimal ? 'minimal work logging' : 'work logging';
    const kind: BlockKind = opts.minimal ? 'minimal' : 'work-log';

    if (opts.minimal) {
      console.log(chalk.dim('Writing the minimal work-log template — no decision example, no per-verb breakdown.'));
    }

    const claudePath = path.join(targetDir, 'CLAUDE.md');
    reportResult(claudePath, upsertBlock(claudePath, block, WORKLOG_UPSERT), label);
    recordBlockWrite(claudePath, kind, WORKLOG_UPSERT.beginMarker, WORKLOG_UPSERT.endMarker);

    const agentsPath = path.join(targetDir, 'AGENTS.md');
    if (fs.existsSync(agentsPath)) {
      reportResult(agentsPath, upsertBlock(agentsPath, block, WORKLOG_UPSERT), label);
      recordBlockWrite(agentsPath, kind, WORKLOG_UPSERT.beginMarker, WORKLOG_UPSERT.endMarker);
    }

    console.log(chalk.dim('  Claude Code sessions under this directory will now auto-log with think sync.'));
  });
