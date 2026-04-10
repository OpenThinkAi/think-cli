import net from 'node:net';
import {
  type Message,
  encodeMessage,
  createMessageParser,
} from './protocol.js';
import {
  getDbVersion,
  getChangeset,
  applyChangeset,
  getPeerInfo,
  updatePeerInfo,
} from '../db/queries.js';
import { getConfig } from '../lib/config.js';

let server: net.Server | null = null;

export function startSyncServer(port: number): net.Server {
  const config = getConfig();

  server = net.createServer((socket) => {
    handleConnection(socket, config.peerId);
  });

  server.listen(port, '0.0.0.0');
  return server;
}

export function stopSyncServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((err) => {
      server = null;
      if (err) reject(err);
      else resolve();
    });
  });
}

type ServerState =
  | 'wait_hello'
  | 'wait_request_changes'
  | 'wait_changes'
  | 'wait_ack'
  | 'wait_done'
  | 'done';

function handleConnection(socket: net.Socket, ownPeerId: string): void {
  let remotePeerId: string | null = null;
  let state: ServerState = 'wait_hello';

  const parser = createMessageParser((msg: Message) => {
    try {
      switch (state) {
        case 'wait_hello': {
          if (msg.type !== 'hello') {
            socket.destroy();
            return;
          }
          remotePeerId = msg.peerId;

          // Send our Hello back
          const dbVersion = getDbVersion();
          socket.write(encodeMessage({
            type: 'hello',
            peerId: ownPeerId,
            dbVersion,
          }));

          state = 'wait_request_changes';
          break;
        }

        case 'wait_request_changes': {
          if (msg.type !== 'request_changes') {
            socket.destroy();
            return;
          }

          // Send our changes to the client
          const currentVersion = getDbVersion();
          const changes = getChangeset(msg.sinceVersion);
          socket.write(encodeMessage({
            type: 'changes',
            changes,
            fromVersion: msg.sinceVersion,
            toVersion: currentVersion,
          }));

          // Request changes from the client
          const peerInfo = getPeerInfo(remotePeerId!);
          const sinceVersion = peerInfo?.last_synced_db_version ?? 0;
          socket.write(encodeMessage({
            type: 'request_changes',
            sinceVersion,
          }));

          state = 'wait_changes';
          break;
        }

        case 'wait_changes': {
          if (msg.type !== 'changes') {
            socket.destroy();
            return;
          }

          // Apply received changes
          if (msg.changes.length > 0) {
            applyChangeset(msg.changes);
          }

          // Send Ack with our current db version
          const versionAfterApply = getDbVersion();
          socket.write(encodeMessage({
            type: 'ack',
            version: versionAfterApply,
          }));

          state = 'wait_ack';
          break;
        }

        case 'wait_ack': {
          if (msg.type !== 'ack') {
            socket.destroy();
            return;
          }

          // Update peer info with the version they reported
          updatePeerInfo(
            remotePeerId!,
            msg.version,
            socket.remoteAddress ?? 'unknown',
          );

          // Send Done
          socket.write(encodeMessage({ type: 'done' }));

          state = 'wait_done';
          break;
        }

        case 'wait_done': {
          if (msg.type !== 'done') {
            socket.destroy();
            return;
          }

          state = 'done';
          socket.end();
          break;
        }
      }
    } catch (err) {
      const peerLabel = remotePeerId ?? 'unknown';
      console.error(`[sync server] error handling message from ${peerLabel}:`, err);
      socket.destroy();
    }
  });

  socket.on('data', (chunk) => parser.push(chunk));
  socket.on('end', () => parser.flush());
  socket.on('error', (err) => {
    console.error('[sync server] connection error:', err.message);
  });
}
