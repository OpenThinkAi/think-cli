import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import chalk from 'chalk';
import { getCuratorMdPath, ensureThinkDirs } from '../lib/paths.js';

const CURATOR_TEMPLATE = `# Curator Guidance

Tell your curator what you consider worth sharing with the team.
This file is read by the curation process every time it runs.

Examples:
- "I work on infrastructure — focus on deploy events, outages, and migration decisions."
- "Track product decisions, customer feedback themes, and roadmap shifts."
- "Skip standup notes and calendar changes."

Write your guidance below this line:

`;

export const curatorCommand = new Command('curator')
  .description('Manage personal curator guidance');

curatorCommand.addCommand(new Command('edit')
  .description('Edit your curator guidance in $EDITOR')
  .action(() => {
    ensureThinkDirs();
    const mdPath = getCuratorMdPath();

    if (!fs.existsSync(mdPath)) {
      fs.writeFileSync(mdPath, CURATOR_TEMPLATE, 'utf-8');
    }

    const editor = process.env.EDITOR || 'vi';
    const result = spawnSync(editor, [mdPath], { stdio: 'inherit' });

    if (result.status === 0) {
      console.log(chalk.green('✓') + ` Curator guidance saved at ${mdPath}`);
    } else {
      console.error(chalk.red('Editor exited with an error.'));
    }
  }));

curatorCommand.addCommand(new Command('show')
  .description('Print your current curator guidance')
  .action(() => {
    const mdPath = getCuratorMdPath();
    if (fs.existsSync(mdPath)) {
      console.log(fs.readFileSync(mdPath, 'utf-8'));
    } else {
      console.log(chalk.dim('No curator guidance configured. Run: think curator edit'));
    }
  }));
