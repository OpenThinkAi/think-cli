import { Command } from 'commander';
import chalk from 'chalk';
import { getAllPeers } from '../db/queries.js';
import { closeDb } from '../db/client.js';

export const networkStatusCommand = new Command('status')
  .description('Show sync peer status')
  .action(() => {
    const peers = getAllPeers();

    if (peers.length === 0) {
      console.log(chalk.yellow('No sync peers recorded yet.'));
      closeDb();
      return;
    }

    console.log(chalk.cyan(`Known peers (${peers.length}):\n`));

    for (const peer of peers) {
      const idShort = chalk.dim(peer.peer_id.slice(0, 8));
      const hostname = peer.hostname ?? 'unknown';
      const lastSeen = peer.last_seen
        ? peer.last_seen.slice(0, 16).replace('T', ' ')
        : 'never';
      const version = String(peer.last_synced_db_version);

      console.log(`  ${idShort}  ${chalk.bold(hostname)}`);
      console.log(`           Last seen: ${chalk.gray(lastSeen)}  DB version: ${chalk.gray(version)}`);
    }

    closeDb();
  });
