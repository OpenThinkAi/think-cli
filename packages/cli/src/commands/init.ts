import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import chalk from 'chalk';

const BEGIN_MARKER = '<!-- think:begin (managed by `think init` — do not edit between markers) -->';
const END_MARKER = '<!-- think:end -->';

const RETRO_BEGIN_MARKER = '<!-- think:retro:begin (managed by `think init --retro` — do not edit between markers) -->';
const RETRO_END_MARKER = '<!-- think:retro:end -->';

const WORKLOG_BLOCK = `# Work Logging

**After every commit, push, PR, deploy, Linear update, non-trivial tool-assisted action, or decision made in conversation, immediately run \`think sync\` before responding to the user's next request. This is not optional.**

\`\`\`
think sync "concise summary of what was done" --silent
think sync "explored X, decided against it" --decision "Decided against X because Y" --silent
\`\`\`

**Do log:** features built, bugs fixed, PRs created/reviewed, deploys, config changes, refactors completed, investigations concluded, decisions made (including decisions to NOT do something), documents written, Linear/external system updates

**Don't log:** clarifying questions, exploration, failed attempts, reading code, debugging dead ends, conversation that didn't produce an outcome

**How to log:**
- One entry per completed task, not per tool call or file edit
- Frame as accomplishments: "Implemented X", "Fixed Y", "Reviewed Z"
- Decisions to not pursue something are logged as: "Decided against X because Y"
- If a task spans the whole session, log at the end
- If multiple distinct things were done, log each separately
- Keep entries concise but specific enough to be useful in a weekly summary
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

function buildBlock(oteamPresent: boolean): string {
  const oteamSegment = oteamPresent ? OTEAM_EXTRA_LINE : '';
  const body = `${WORKLOG_BLOCK}${oteamSegment}\n${RETRO_BLOCK}`;
  return `${BEGIN_MARKER}\n${body}${END_MARKER}\n`;
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
  .option('--retro', 'Upsert the iterative-learning (retro) block instead of the work-logging block. Requires --cortex.')
  .option('--cortex <name>', 'Cortex name baked into the retro block commands (required with --retro).')
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

Examples:
  think init                              # work-log block in ~/CLAUDE.md
  think init --dir . --yes                # work-log block in ./CLAUDE.md
  think init --retro --cortex fx-tracker  # retro block in ~/CLAUDE.md
  think init --dir . --retro --cortex my-repo --yes
`)
  .action(async function (this: Command, opts: { dir?: string; yes?: boolean; retro?: boolean; cortex?: string }) {
    // The program declares a global `-C, --cortex <name>` option which shadows
    // the subcommand-local `--cortex` when invoked through the full CLI. Fall
    // back to the global so both `think -C foo init --retro` and
    // `think init --retro --cortex foo` resolve to the same value.
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const cortex = opts.cortex ?? globalOpts.cortex;

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

    const oteamPresent = detectOteamWorkspace(home);
    const block = buildBlock(oteamPresent);
    const label = 'work logging';

    if (oteamPresent) {
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
