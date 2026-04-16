export interface SyncAdapter {
  readonly name: string;

  /** Push locally-created memories to the remote */
  push(cortex: string): Promise<SyncResult>;

  /** Pull remotely-created memories into local SQLite */
  pull(cortex: string): Promise<SyncResult>;

  /** Push + Pull in one call */
  sync(cortex: string): Promise<SyncResult>;

  /** List cortexes available on the remote */
  listRemoteCortexes(): Promise<string[]>;

  /** Create a new cortex on the remote */
  createCortex(cortex: string): Promise<void>;

  /** Check if the backend is configured and reachable */
  isAvailable(): boolean;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  errors: string[];
}
