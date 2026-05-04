import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import chalk from 'chalk';

const BEGIN_MARKER = '<!-- think:begin (managed by `think init` — do not edit between markers) -->';
const END_MARKER = '<!-- think:end -->';

const BASE_BLOCK = `# Work Logging

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

// Fingerprint that identifies a pre-marker (legacy) think block written by an
// older version of this command. Both substrings come from BASE_BLOCK and are
// distinctive enough that co-occurrence outside markers is the legacy signal.
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
  const body = oteamPresent ? BASE_BLOCK + OTEAM_EXTRA_LINE : BASE_BLOCK;
  return `${BEGIN_MARKER}\n${body}${END_MARKER}\n`;
}

type UpsertResult =
  | { kind: 'created' }
  | { kind: 'replaced' }
  | { kind: 'appended' }
  | { kind: 'migrated'; backupPath: string }
  | { kind: 'unchanged' };

function upsertBlock(filePath: string, block: string): UpsertResult {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, block, 'utf-8');
    return { kind: 'created' };
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  const beginIdx = existing.indexOf(BEGIN_MARKER);
  const endIdx = existing.indexOf(END_MARKER);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx);
    const afterStart = endIdx + END_MARKER.length;
    // Drop a single trailing newline after the END marker so the replacement
    // (which itself ends in "\n") doesn't compound blank lines on every run.
    const after = existing.slice(existing[afterStart] === '\n' ? afterStart + 1 : afterStart);
    const next = before + block + after;
    if (next === existing) return { kind: 'unchanged' };
    fs.writeFileSync(filePath, next, 'utf-8');
    return { kind: 'replaced' };
  }

  // No markers — check for a legacy unscoped block to migrate in place.
  if (existing.includes(LEGACY_FINGERPRINT_A) && existing.includes(LEGACY_FINGERPRINT_B)) {
    const headingIdx = existing.indexOf('# Work Logging');
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

function prompt(question: string, defaultValue: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

function reportResult(filePath: string, result: UpsertResult): void {
  switch (result.kind) {
    case 'created':
      console.log(chalk.green('✓') + ` Created ${filePath} with work logging instructions`);
      break;
    case 'replaced':
      console.log(chalk.green('✓') + ` Updated work logging block in ${filePath}`);
      break;
    case 'appended':
      console.log(chalk.green('✓') + ` Appended work logging instructions to ${filePath}`);
      break;
    case 'migrated':
      console.log(
        chalk.green('✓') +
          ` Migrated legacy work logging block in ${filePath} → scoped markers. Pre-migration copy saved to ${result.backupPath}; review the diff if you had local edits.`,
      );
      break;
    case 'unchanged':
      console.log(chalk.dim(`${filePath} already up to date.`));
      break;
  }
}

export const initCommand = new Command('init')
  .description(
    'Set up Claude Code integration: upserts a marker-bracketed work-logging block in CLAUDE.md (and AGENTS.md if present); block adapts when an oteam workspace is detected',
  )
  .option('-d, --dir <path>', 'Target directory for CLAUDE.md')
  .option('-y, --yes', 'Skip confirmation, use defaults')
  .action(async (opts: { dir?: string; yes?: boolean }) => {
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

    const oteamPresent = detectOteamWorkspace(home);
    const block = buildBlock(oteamPresent);

    if (oteamPresent) {
      console.log(chalk.dim('Detected oteam workspace — block tuned for role-pipeline cadence.'));
    }

    const claudePath = path.join(targetDir, 'CLAUDE.md');
    reportResult(claudePath, upsertBlock(claudePath, block));

    const agentsPath = path.join(targetDir, 'AGENTS.md');
    if (fs.existsSync(agentsPath)) {
      reportResult(agentsPath, upsertBlock(agentsPath, block));
    }

    console.log(chalk.dim('  Claude Code sessions under this directory will now auto-log with think sync.'));
  });
