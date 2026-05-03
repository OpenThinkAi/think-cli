import { mockConnector } from './mock.js';
import type { SourceConnector } from './types.js';

/**
 * Map of `kind` → registered connector. The scheduler iterates active
 * subscriptions, looks up the connector for each `subscription.kind`,
 * and skips (with a warning) any kind not in this map.
 *
 * `mock` is the only kind shipped in 0.4.0. The forward-looking `github`
 * connector design lives at `docs/design/connectors-github.md`; the live
 * implementation lands in AGT-029+ at `connectors/github.ts` and will
 * register itself here.
 */
export type ConnectorRegistry = Map<string, SourceConnector>;

export function buildDefaultRegistry(): ConnectorRegistry {
  const registry: ConnectorRegistry = new Map();
  registry.set(mockConnector.kind, mockConnector);
  return registry;
}

export function registerConnector(
  registry: ConnectorRegistry,
  connector: SourceConnector,
): void {
  registry.set(connector.kind, connector);
}
