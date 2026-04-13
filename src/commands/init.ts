import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import chalk from 'chalk';

const CLAUDE_MD_SECTION = `# Work Logging

**After every commit, push, PR, deploy, Linear update, or non-trivial tool-assisted action, immediately run \`think sync\` before responding to the user's next request. This is not optional.**

\`\`\`
think sync "concise summary of what was done" --silent
\`\`\`

**Do log:** features built, bugs fixed, PRs created/reviewed, deploys, config changes, refactors completed, investigations concluded, decisions made, documents written, Linear/external system updates

**Don't log:** clarifying questions, exploration, failed attempts, reading code, debugging dead ends, conversation that didn't produce an outcome

**How to log:**
- One entry per completed task, not per tool call or file edit
- Frame as accomplishments: "Implemented X", "Fixed Y", "Reviewed Z"
- If a task spans the whole session, log at the end
- If multiple distinct things were done, log each separately
- Keep entries concise but specific enough to be useful in a weekly summary
`;

function prompt(question: string, defaultValue: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

export const initCommand = new Command('init')
  .description('Set up Claude Code integration (writes CLAUDE.md with work logging instructions)')
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

    const filePath = path.join(targetDir, 'CLAUDE.md');
    const exists = fs.existsSync(filePath);

    if (exists) {
      const existing = fs.readFileSync(filePath, 'utf-8');
      if (existing.includes('think sync')) {
        console.log(chalk.dim('CLAUDE.md already contains think sync instructions. Nothing to do.'));
        return;
      }

      // Append to existing file
      const separator = existing.endsWith('\n') ? '\n' : '\n\n';
      fs.writeFileSync(filePath, existing + separator + CLAUDE_MD_SECTION, 'utf-8');
      console.log(chalk.green('✓') + ` Appended work logging instructions to ${filePath}`);
    } else {
      fs.writeFileSync(filePath, CLAUDE_MD_SECTION, 'utf-8');
      console.log(chalk.green('✓') + ` Created ${filePath} with work logging instructions`);
    }

    console.log(chalk.dim('  Claude Code sessions under this directory will now auto-log with think sync.'));
  });
