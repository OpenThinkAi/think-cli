import { createGitHubConnector } from './github.js';
import { mockConnector } from './mock.js';
import type { SourceConnector } from './types.js';

/**
 * Map of `kind` → registered connector. The scheduler iterates active
 * subscriptions, looks up the connector for each `subscription.kind`,
 * and skips (with a warning) any kind not in this map.
 *
 * `mock` exists for end-to-end tests and dev-time smoke. `github`
 * (AGT-387) emits terminal events for PR merges, PR closes, issue
 * closures, and release publications against a `<owner>/<repo>` pattern.
 */
export type ConnectorRegistry = Map<string, SourceConnector>;

export function buildDefaultRegistry(): ConnectorRegistry {
  const registry: ConnectorRegistry = new Map();
  registry.set(mockConnector.kind, mockConnector);
  // The github connector takes no runtime dependencies at construction
  // — it pulls its PAT from `ctx.credential` on each poll. A single
  // default instance services every github subscription.
  const github = createGitHubConnector();
  registry.set(github.kind, github);
  return registry;
}

export function registerConnector(
  registry: ConnectorRegistry,
  connector: SourceConnector,
): void {
  registry.set(connector.kind, connector);
}
