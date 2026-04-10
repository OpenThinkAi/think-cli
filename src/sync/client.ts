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

export interface SyncResult {
  peerHostname: string;
  changesSent: number;
  changesReceived: number;
}

type ClientState =
  | 'wait_hello'
  | 'wait_changes'
  | 'wait_request_changes'
  | 'wait_ack'
  | 'wait_done'
  | 'done';

export function syncWithPeer(host: string, port: number): Promise<SyncResult> {
  return new Promise((resolve, reject) => {
    const config = getConfig();
    let state: ClientState = 'wait_hello';
    let remotePeerId: string | null = null;
    let changesSent = 0;
    let changesReceived = 0;

    const socket = net.createConnection({ host, port }, () => {
      // Connected — send Hello
      const dbVersion = getDbVersion();
      socket.write(encodeMessage({
        type: 'hello',
        peerId: config.peerId,
        dbVersion,
      }));
    });

    const parser = createMessageParser((msg: Message) => {
      try {
        switch (state) {
          case 'wait_hello': {
            if (msg.type !== 'hello') {
              socket.destroy(new Error(`Expected hello, got ${msg.type}`));
              return;
            }
            remotePeerId = msg.peerId;

            // Send RequestChanges using last known version for this peer
            const peerInfo = getPeerInfo(remotePeerId);
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
              socket.destroy(new Error(`Expected changes, got ${msg.type}`));
              return;
            }

            // Apply received changes
            changesReceived = msg.changes.length;
            if (msg.changes.length > 0) {
              applyChangeset(msg.changes);
            }

            state = 'wait_request_changes';
            break;
          }

          case 'wait_request_changes': {
            if (msg.type !== 'request_changes') {
              socket.destroy(new Error(`Expected request_changes, got ${msg.type}`));
              return;
            }

            // Send our changes to the server
            const changes = getChangeset(msg.sinceVersion);
            const currentVersion = getDbVersion();
            changesSent = changes.length;
            socket.write(encodeMessage({
              type: 'changes',
              changes,
              fromVersion: msg.sinceVersion,
              toVersion: currentVersion,
            }));

            state = 'wait_ack';
            break;
          }

          case 'wait_ack': {
            if (msg.type !== 'ack') {
              socket.destroy(new Error(`Expected ack, got ${msg.type}`));
              return;
            }

            // Send our Ack with current db version
            const versionAfterSync = getDbVersion();
            socket.write(encodeMessage({
              type: 'ack',
              version: versionAfterSync,
            }));

            state = 'wait_done';
            break;
          }

          case 'wait_done': {
            if (msg.type !== 'done') {
              socket.destroy(new Error(`Expected done, got ${msg.type}`));
              return;
            }

            // Update peer info
            updatePeerInfo(
              remotePeerId!,
              getDbVersion(),
              host,
            );

            // Send Done and close
            socket.write(encodeMessage({ type: 'done' }));
            state = 'done';
            socket.end();

            resolve({
              peerHostname: host,
              changesSent,
              changesReceived,
            });
            break;
          }
        }
      } catch (err) {
        socket.destroy();
        reject(err);
      }
    });

    socket.on('data', (chunk) => parser.push(chunk));
    socket.on('end', () => {
      parser.flush();
      if (state !== 'done') {
        reject(new Error(`Connection closed unexpectedly in state: ${state}`));
      }
    });
    socket.on('error', (err) => {
      reject(new Error(`Sync connection to ${host}:${port} failed: ${err.message}`));
    });
  });
}
