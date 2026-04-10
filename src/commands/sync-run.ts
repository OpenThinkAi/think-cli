import { Command } from 'commander';
import chalk from 'chalk';
import { syncWithPeer } from '../sync/client.js';
import { startSyncServer, stopSyncServer } from '../sync/server.js';
import { advertise, discoverPeers, stopDiscovery } from '../sync/discovery.js';
import { getConfig } from '../lib/config.js';
import { closeDb } from '../db/client.js';

export const networkSyncCommand = new Command('sync')
  .description('Start server, discover peers, and sync')
  .option('--host <host>', 'Connect to a specific peer instead of discovering')
  .option('--port <port>', 'Port for sync', '47821')
  .option('--timeout <ms>', 'mDNS discovery timeout in milliseconds', '5000')
  .option('--wait', 'Keep running and wait for incoming connections after syncing')
  .action(async (opts: { host?: string; port: string; timeout: string; wait?: boolean }) => {
    const port = parseInt(opts.port, 10);
    const timeout = parseInt(opts.timeout, 10);
    const config = getConfig();

    try {
      if (opts.host) {
        // Direct sync with a specific peer — no server needed
        console.log(chalk.cyan(`Connecting to ${opts.host}:${port}...`));
        const result = await syncWithPeer(opts.host, port);
        console.log(chalk.green('✓') + ` Synced with ${result.peerHostname}`);
        console.log(`  Sent: ${result.changesSent} changes, Received: ${result.changesReceived} changes`);
        closeDb();
        return;
      }

      // Start the sync server so peers can connect to us
      startSyncServer(port);
      console.log(chalk.cyan(`Sync server listening on port ${port}`));

      // Advertise ourselves via mDNS
      advertise(config.peerId, port);
      console.log(chalk.cyan(`Advertising via mDNS as think-${config.peerId.slice(0, 8)}`));

      // Discover and sync with any peers already on the network
      console.log(chalk.cyan(`Discovering peers (${timeout}ms)...`));
      const peers = await discoverPeers(timeout);

      if (peers.length === 0) {
        console.log(chalk.yellow('No peers found on the local network.'));
      } else {
        console.log(chalk.cyan(`Found ${peers.length} peer(s):`));
        for (const peer of peers) {
          console.log(`  ${chalk.dim(peer.peerId.slice(0, 8))} ${peer.host}:${peer.port} (${peer.name})`);
        }
        console.log();

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
        console.log(`Synced with ${successCount}/${peers.length} peer(s).`);
      }

      if (opts.wait) {
        // Keep running so the other machine can initiate sync to us
        console.log();
        console.log(chalk.cyan('Waiting for incoming connections... (Ctrl-C to stop)'));
        process.on('SIGINT', async () => {
          console.log(chalk.dim('\nShutting down...'));
          stopDiscovery();
          await stopSyncServer();
          closeDb();
          process.exit(0);
        });
      } else {
        // Give a short window for any incoming connections, then exit
        console.log(chalk.dim('Listening for incoming connections for 5s...'));
        await new Promise((resolve) => setTimeout(resolve, 5000));
        stopDiscovery();
        await stopSyncServer();
        closeDb();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Sync error: ${message}`));
      stopDiscovery();
      await stopSyncServer();
      closeDb();
      process.exit(1);
    }
  });
