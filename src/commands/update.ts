import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import chalk from 'chalk';

export const updateCommand = new Command('update')
  .description('Update think to the latest version')
  .action(() => {
    console.log(chalk.cyan('Checking for updates...'));

    try {
      const result = execFileSync('npm', ['install', '-g', 'open-think@latest'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Extract version from npm output
      const match = result.match(/open-think@(\S+)/);
      const version = match ? match[1] : 'latest';

      console.log(chalk.green('✓') + ` Updated to open-think@${version}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red('Update failed. Try manually: npm install -g open-think@latest'));
      if (message.includes('EACCES')) {
        console.error(chalk.dim('  You may need to run with sudo or fix npm permissions.'));
      }
    }
  });
