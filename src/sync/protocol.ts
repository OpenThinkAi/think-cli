// Sync protocol message types and wire format for P2P sync.
// Messages are newline-delimited JSON over TCP.

export interface Hello {
  type: 'hello';
  peerId: string;
  dbVersion: number;
}

export interface RequestChanges {
  type: 'request_changes';
  sinceVersion: number;
}

export interface Changes {
  type: 'changes';
  changes: unknown[];
  fromVersion: number;
  toVersion: number;
}

export interface Ack {
  type: 'ack';
  version: number;
}

export interface Done {
  type: 'done';
}

export type Message = Hello | RequestChanges | Changes | Ack | Done;

export function encodeMessage(msg: Message): string {
  return JSON.stringify(msg) + '\n';
}

/**
 * Creates a stateful message parser that accumulates TCP chunks
 * and emits complete parsed Message objects via a callback.
 */
export function createMessageParser(onMessage: (msg: Message) => void): {
  push: (chunk: Buffer | string) => void;
  flush: () => void;
} {
  let buffer = '';

  return {
    push(chunk: Buffer | string) {
      buffer += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line.length > 0) {
          try {
            const msg = JSON.parse(line) as Message;
            onMessage(msg);
          } catch {
            // Skip malformed lines
          }
        }
      }
    },
    flush() {
      const line = buffer.trim();
      if (line.length > 0) {
        try {
          const msg = JSON.parse(line) as Message;
          onMessage(msg);
        } catch {
          // Skip malformed lines
        }
      }
      buffer = '';
    },
  };
}
