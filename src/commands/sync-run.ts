import { Command } from 'commander';
import chalk from 'chalk';
import { syncWithPeer } from '../sync/client.js';
import { discoverPeers, stopDiscovery } from '../sync/discovery.js';
import { closeDb } from '../db/client.js';

export const networkSyncCommand = new Command('sync')
  .description('Sync with discovered peers or a specific host')
  .option('--host <host>', 'Connect to a specific peer')
  .option('--port <port>', 'Port for the specific peer', '47821')
  .option('--timeout <ms>', 'mDNS discovery timeout in milliseconds', '3000')
  .action(async (opts: { host?: string; port: string; timeout: string }) => {
    try {
      if (opts.host) {
        // Direct sync with a specific peer
        const port = parseInt(opts.port, 10);
        console.log(chalk.cyan(`Connecting to ${opts.host}:${port}...`));

        const result = await syncWithPeer(opts.host, port);
        console.log(chalk.green('✓') + ` Synced with ${result.peerHostname}`);
        console.log(`  Sent: ${result.changesSent} changes, Received: ${result.changesReceived} changes`);
      } else {
        // Discover peers via mDNS
        const timeout = parseInt(opts.timeout, 10);
        console.log(chalk.cyan(`Discovering peers (${timeout}ms timeout)...`));

        const peers = await discoverPeers(timeout);

        if (peers.length === 0) {
          console.log(chalk.yellow('No peers found on the local network.'));
          stopDiscovery();
          closeDb();
          return;
        }

        console.log(chalk.cyan(`Found ${peers.length} peer(s):`));
        for (const peer of peers) {
          console.log(`  ${chalk.dim(peer.peerId.slice(0, 8))} ${peer.host}:${peer.port} (${peer.name})`);
        }
        console.log();

        // Sync with each discovered peer
        let successCount = 0;
        for (const peer of peers) {
          try {
            console.log(chalk.cyan(`Syncing with ${peer.name} (${peer.host}:${peer.port})...`));
            const result = await syncWithPeer(peer.host, peer.port);
            console.log(chalk.green('✓') + ` Synced with ${result.peerHostname}`);
            console.log(`  Sent: ${result.changesSent} changes, Received: ${result.changesReceived} changes`);
            successCount++;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.log(chalk.red('✗') + ` Failed to sync with ${peer.name}: ${message}`);
          }
        }

        console.log();
        console.log(`Sync complete: ${successCount}/${peers.length} peer(s) synced successfully.`);
      }

      stopDiscovery();
      closeDb();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Sync error: ${message}`));
      stopDiscovery();
      closeDb();
      process.exit(1);
    }
  });
