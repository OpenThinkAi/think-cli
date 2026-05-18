import { execSync } from 'node:child_process';
import { Command } from 'commander';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import chalk from 'chalk';

const BEGIN_MARKER = '<!-- think:begin (managed by `think init` — do not edit between markers) -->';
const END_MARKER = '<!-- think:end -->';

const RETRO_BEGIN_MARKER = '<!-- think:retro:begin (managed by `think init --retro` — do not edit between markers) -->';
const RETRO_END_MARKER = '<!-- think:retro:end -->';

// Default work-log template, reframed toward minimum-necessary. The
// previous version instructed agents to log "every meaningful action
// and decisions made in conversation" with "this is not optional"
// framing — biased toward over-collection of context that often
// included customer names, internal architecture, and personnel
// discussions. The privacy paragraph below names the engrams →
// curation → Anthropic data flow so users can choose informedly.
const WORKLOG_BLOCK = `# Work Logging

After shipping a change (commit pushed, PR opened, deploy completed, or a decision committed to and acted on), run \`think sync\` to record the outcome:

\`\`\`
think sync "concise summary of what shipped" --silent
think sync "Decided against X because Y" --decision "Decided against X because Y" --silent
\`\`\`

**Do log:** shipped outcomes — features built, bugs fixed, PRs created/reviewed, deploys, config changes, refactors completed, decisions committed to (including decisions to NOT do something), documents written, Linear/external system updates.

**Don't log:** conversational deliberation, exploration, failed attempts, reading code, debugging dead ends, clarifying questions, anything that didn't produce a shipped outcome.

**Privacy: where these entries go.** Each \`think sync\` writes a local engram. The curator (\`think curate\`) consolidates engrams into memories; with curator consent granted (\`THINK_LLM_CONSENT=1\` or \`cortex.llmConsent\` in \`~/.config/think/config.json\`), curated content is sent to Anthropic for synthesis. Choose what to log accordingly — anything about customers, internal architecture, or personnel ends up in the same pipeline as anything else. \`think pause\` suppresses engram creation if you need a pause window.

**How to log:**
- One entry per shipped outcome, not per tool call or file edit
- Frame as accomplishments: "Implemented X", "Fixed Y", "Reviewed Z"
- Decisions not to pursue something: "Decided against X because Y"
- If a task spans the whole session, log at the end
- If multiple distinct things shipped, log each separately
- Keep entries concise but specific enough to be useful in a weekly summary
`;

// `--minimal` template. Even more conservative than the default —
// only explicit shipped outcomes, no decision-narration, no example
// showing how to log negative decisions. For users who want the
// absolute floor of what gets sent to Anthropic if they grant curator
// consent later.
const MINIMAL_WORKLOG_BLOCK = `# Work Logging (minimal)

When you ship a change, log the outcome:

\`\`\`
think sync "shipped X" --silent
\`\`\`

That's all. Don't run \`think sync\` for exploration, debugging, decisions that weren't acted on, or anything mid-conversation. Logged entries become engrams; with curator consent granted (\`THINK_LLM_CONSENT=1\`), curated content reaches Anthropic. The minimal template keeps that pipeline narrow by design — augment with the default template (\`think init --yes\`) if you decide you want richer logging later.
`;

// v3 work-log template. Recall is now implicit via the hook + MCP server,
// so the "you MUST recall per-activity" hard rule from v2 shrinks to a
// brief note. The three verbs (sync/retro/event) replace the v2 sync-only
// model. Cortex inference is unchanged.
const V3_WORKLOG_BLOCK = `# think v3

Context is auto-injected via the UserPromptSubmit hook on every turn (additionalContext field); call the \`think_recall\` MCP tool mid-conversation when you need to drill into a specific topic. You don't need to manually run \`think recall\` unless you want to inspect what's stored.

Three verbs for writing:

- \`think sync "<content>"\` — work stream; kind=memory. Use after shipping a change (commit pushed, PR opened, deploy completed).
- \`think retro "<content>"\` — durable wisdom about a codebase; kind=retro. Use when you notice a convention, invariant, gotcha, or prior decision worth preserving for the next agent in this repo. Text is preserved exactly as written.
- \`think event "<content>"\` — notable thing happened; kind=event. Use for milestones, decisions, incidents. Events accumulate and are never superseded.

Cortex is inferred from the repo basename (\`basename "$(git rev-parse --show-toplevel)"\`) unless you pass \`--cortex <name>\` explicitly. For repos with a stable name, prefer \`think init --retro --cortex <name>\` to bake it into the block.
`;

const OTEAM_EXTRA_LINE = `\n**Under an \`oteam\` workspace:** run \`think recall\` before \`oteam assign\` and \`think sync\` after each role-pipeline hand-off.\n`;

const RETRO_BLOCK = `# Iterative Learning

When you observe a convention, invariant, prior decision, or gotcha worth remembering about a repo, leave a retro for the next agent who works on it:

\`\`\`
think retro "<observation>" --cortex <repo-basename>
\`\`\`

\`<repo-basename>\` is the basename of the repo's root directory — \`basename "$(git rev-parse --show-toplevel)"\` (e.g., \`fx-tracker\`, \`ui-host\`). For repos that have a stable cortex name, prefer the per-repo \`think init --retro --cortex <name>\` block — it bakes the cortex literally so agents don't have to infer it.

Loose triggers — you decide when to emit. Examples:

- an undocumented convention you had to figure out
- a missing or stale type contract that blocked work
- a surprising invariant in the code
- a gotcha that looks like a bug but is intentional
- a prior decision worth not re-litigating

# Reading retros at task start

Before non-trivial work in a repo (especially the first time touching it in a session), load prior retros + personal context:

\`\`\`
think brief --cortex <repo-basename>
\`\`\`

Optional, not required — orchestrator skills (\`/assign-ticket\`, \`/implement-project\`) handle this deterministically when applicable.
`;

// Fingerprint that identifies a pre-marker (legacy) think block written by an
// older version of this command. Both substrings come from WORKLOG_BLOCK and
// are distinctive enough that co-occurrence outside markers is the legacy signal.
const LEGACY_FINGERPRINT_A = '**After every commit';
const LEGACY_FINGERPRINT_B = 'think sync';

function detectOteamWorkspace(home: string): boolean {
  const cfgPath = path.join(home, '.open-team', 'config.json');
  if (!fs.existsSync(cfgPath)) return false;
  try {
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const workspaces = (parsed && typeof parsed === 'object' && (parsed.workspaces ?? parsed.vaults)) as
      | Record<string, unknown>
      | undefined;
    return !!workspaces && typeof workspaces === 'object' && Object.keys(workspaces).length > 0;
  } catch {
    return false;
  }
}

// Attempt a zero-byte connect to the v3 daemon socket with a short timeout.
// Returns true only if the socket accepts the connection. Any error or timeout
// is treated as "daemon not reachable" — safe fallback to v2 block.
// Accepts home so tests can override via process.env.HOME without re-deriving.
function isV3DaemonReachable(home: string, timeoutMs = 300): Promise<boolean> {
  const socketPath = path.join(home, '.think', 'daemon.sock');
  // Fast path: if the socket file doesn't exist the probe would fail immediately,
  // but skip the net.createConnection call entirely to avoid even the ENOENT round-trip.
  if (!fs.existsSync(socketPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function buildBlock(oteamPresent: boolean, minimal = false, version: 'v2' | 'v3' = 'v2'): string {
  if (minimal) {
    // Wrap the minimal body in the same begin/end markers as the default
    // path so `upsertBlock` can replace-in-place across re-runs and
    // `--minimal` ↔ default switches. Without the markers, every
    // re-invocation would append a fresh block (no marker → no
    // existing-block detection → fall through to plain append).
    return `${BEGIN_MARKER}\n${MINIMAL_WORKLOG_BLOCK}${END_MARKER}\n`;
  }
  if (version === 'v3') {
    const oteamSegment = oteamPresent ? OTEAM_EXTRA_LINE : '';
    const body = `${V3_WORKLOG_BLOCK}${oteamSegment}`;
    return `${BEGIN_MARKER}\n${body}${END_MARKER}\n`;
  }
  const oteamSegment = oteamPresent ? OTEAM_EXTRA_LINE : '';
  const body = `${WORKLOG_BLOCK}${oteamSegment}\n${RETRO_BLOCK}`;
  return `${BEGIN_MARKER}\n${body}${END_MARKER}\n`;
}

// Pre-write disclosure of the engrams → curation → Anthropic data flow
// for interactive sessions. Returns true if the user confirms; false to
// abort. `--yes` and `--minimal` skip this entirely (non-interactive
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

  console.log(chalk.yellow(`Heads up: this writes a CLAUDE.md block instructing Claude Code to run \`think sync\` on shipped outcomes.`));
  console.log(chalk.yellow(`Each \`think sync\` is a local engram. With curator consent (\`THINK_LLM_CONSENT=1\` or`));
  console.log(chalk.yellow(`\`cortex.llmConsent\`), curated content flows to Anthropic for synthesis.`));
  console.log();
  console.log(chalk.dim(`This template (the non-minimal default) logs shipped outcomes + decisions, no conversational deliberation.`));
  console.log(chalk.dim(`To skip this prompt: \`think init --yes\` (this template) or \`think init --minimal\` (more conservative).`));
  console.log();

  const answer = await prompt(`Write the CLAUDE.md block? [Y/n] `, 'y');
  return /^y(es)?$/i.test(answer.trim());
}

function buildRetroBlock(cortex: string): string {
  const body = `# Iterative Learning

This repo participates in agentic iterative learning via \`think retro\`. Treat retros as a peer-to-future-agents channel: read what others have left for you, and leave behind what would have helped you.

**Read at task start.** Before any non-trivial task in this repo, run:

\`\`\`
think brief --cortex ${cortex}
\`\`\`

Use the output to inform the work — prior conventions, invariants, decisions, and gotchas other agents have already learned.

**Write when you notice something worth remembering.** When you discover a convention, invariant, prior decision, or gotcha another agent would benefit from knowing, run:

\`\`\`
think retro "<observation>" --cortex ${cortex}
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

type UpsertResult =
  | { kind: 'created' }
  | { kind: 'replaced' }
  | { kind: 'appended' }
  | { kind: 'migrated'; backupPath: string }
  | { kind: 'unchanged' };

interface UpsertOptions {
  beginMarker: string;
  endMarker: string;
  legacyMigration?: {
    fingerprintA: string;
    fingerprintB: string;
    heading: string;
  };
}

function upsertBlock(filePath: string, block: string, opts: UpsertOptions): UpsertResult {
  const { beginMarker, endMarker, legacyMigration } = opts;

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, block, 'utf-8');
    return { kind: 'created' };
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  const beginIdx = existing.indexOf(beginMarker);
  const endIdx = existing.indexOf(endMarker);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx);
    const afterStart = endIdx + endMarker.length;
    // Drop a single trailing newline after the END marker so the replacement
    // (which itself ends in "\n") doesn't compound blank lines on every run.
    const after = existing.slice(existing[afterStart] === '\n' ? afterStart + 1 : afterStart);
    const next = before + block + after;
    if (next === existing) return { kind: 'unchanged' };
    fs.writeFileSync(filePath, next, 'utf-8');
    return { kind: 'replaced' };
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

const WORKLOG_UPSERT: UpsertOptions = {
  beginMarker: BEGIN_MARKER,
  endMarker: END_MARKER,
  legacyMigration: {
    fingerprintA: LEGACY_FINGERPRINT_A,
    fingerprintB: LEGACY_FINGERPRINT_B,
    heading: '# Work Logging',
  },
};

const RETRO_UPSERT: UpsertOptions = {
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
    'Set up Claude Code integration: upserts a marker-bracketed block in CLAUDE.md (and AGENTS.md if present) with work-logging guidance and generic iterative-learning instructions (read via `think brief`, write via `think retro`, cortex inferred from the repo basename); block adapts when an oteam workspace is detected. Pass --retro --cortex <name> to upsert a *separate* repo-scoped block that bakes the cortex name into the read/write commands literally — both blocks can coexist in the same file.',
  )
  .option('-d, --dir <path>', 'Target directory for CLAUDE.md')
  .option('-y, --yes', 'Skip confirmation, use defaults')
  .option('--minimal', 'Write a conservative work-log template that logs only explicit shipped outcomes — no decision narration, no oteam adaptation, no retro pattern. Skips the disclosure prompt. Mutually exclusive with --retro.')
  .option('--retro', 'Upsert the iterative-learning (retro) block instead of the work-logging block. Requires --cortex. When no -d is given: writes silently to the git repo root if inside a repo; prompts with cwd as the default otherwise.')
  .option('--cortex <name>', 'Cortex name baked into the retro block commands (required with --retro).')
  .option('--block-version <ver>', 'Force block version: v2 (standard, default) or v3 (hook + MCP server). When omitted, v3 is used if the daemon is reachable; otherwise v2.')
  .addHelpText('after', `
Modes:
  Default (no --retro):
    Manages a single block in CLAUDE.md (and AGENTS.md if present)
    containing work-logging guidance plus generic retro pattern
    instructions (read with \`think brief\`, write with \`think retro\`,
    cortex inferred from the repo's root basename). Block adapts when an
    oteam workspace is detected. Best installed once at workspace level.

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
  think init --block-version v3           # force v3 block even without daemon
  think init --retro --cortex fx-tracker  # retro block at git root (silent)
  think init --dir . --retro --cortex my-repo  # retro block in ./CLAUDE.md
`)
  .action(async function (this: Command, opts: { dir?: string; yes?: boolean; minimal?: boolean; retro?: boolean; cortex?: string; blockVersion?: string }) {
    // The program declares a global `-C, --cortex <name>` option which shadows
    // the subcommand-local `--cortex` when invoked through the full CLI. Fall
    // back to the global so both `think -C foo init --retro` and
    // `think init --retro --cortex foo` resolve to the same value.
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const cortex = opts.cortex ?? globalOpts.cortex;

    // Validate --block-version flag early.
    const versionFlag = opts.blockVersion;
    if (versionFlag !== undefined && versionFlag !== 'v2' && versionFlag !== 'v3') {
      console.error(chalk.red(`think init: --block-version must be 'v2' or 'v3', got '${versionFlag}'.`));
      process.exit(1);
    }
    const forcedVersion = versionFlag as 'v2' | 'v3' | undefined;

    // --minimal and --block-version are mutually exclusive: minimal always writes the minimal
    // v2-style template; a --block-version flag would be silently ignored by buildBlock.
    if (opts.minimal && forcedVersion !== undefined) {
      console.error(chalk.red('think init: --minimal and --block-version are mutually exclusive.'));
      process.exit(1);
    }

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

      const claudePath = path.join(targetDir, 'CLAUDE.md');
      reportResult(claudePath, upsertBlock(claudePath, block, RETRO_UPSERT), label);

      const agentsPath = path.join(targetDir, 'AGENTS.md');
      if (fs.existsSync(agentsPath)) {
        reportResult(agentsPath, upsertBlock(agentsPath, block, RETRO_UPSERT), label);
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
    // is invoked programmatically by orchestrator skills like
    // /assign-ticket; adding interactive friction there would block
    // those flows. The retro path's own data flow disclosure lives in
    // SECURITY.md "Per-curation data envelope" + retro-recall docs.
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

    // Determine which block version to write:
    //   1. --version v3 → always v3
    //   2. --version v2 → always v2
    //   3. No flag → probe daemon; v3 if reachable, v2 otherwise
    let version: 'v2' | 'v3';
    if (forcedVersion !== undefined) {
      version = forcedVersion;
    } else {
      version = (await isV3DaemonReachable(home)) ? 'v3' : 'v2';
    }

    const oteamPresent = detectOteamWorkspace(home);
    const block = buildBlock(oteamPresent, opts.minimal, version);
    const label = opts.minimal ? 'minimal work logging' : 'work logging';

    if (opts.minimal) {
      console.log(chalk.dim('Writing the minimal work-log template — no oteam adaptation, no retro pattern, no decision narration.'));
    } else if (version === 'v3') {
      console.log(chalk.dim('Writing v3 block (implicit recall via hook + MCP server).'));
    } else if (oteamPresent) {
      console.log(chalk.dim('Detected oteam workspace — block tuned for role-pipeline cadence.'));
    }

    const claudePath = path.join(targetDir, 'CLAUDE.md');
    reportResult(claudePath, upsertBlock(claudePath, block, WORKLOG_UPSERT), label);

    const agentsPath = path.join(targetDir, 'AGENTS.md');
    if (fs.existsSync(agentsPath)) {
      reportResult(agentsPath, upsertBlock(agentsPath, block, WORKLOG_UPSERT), label);
    }

    console.log(chalk.dim('  Claude Code sessions under this directory will now auto-log with think sync.'));
  });
