import { createGitHubConnector } from './github.js';
import { createLinearConnector } from './linear.js';
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
 * `linear` (AGT-392) emits terminal events for issue completion and
 * cancellation against a `<team-key>` pattern (e.g. `ENG`).
 */
export type ConnectorRegistry = Map<string, SourceConnector>;

export function buildDefaultRegistry(): ConnectorRegistry {
  const registry: ConnectorRegistry = new Map();
  registry.set(mockConnector.kind, mockConnector);
  // The github and linear connectors take no runtime dependencies at
  // construction — they pull their credential from `ctx.credential` on
  // each poll. One default instance per kind services every subscription
  // of that kind.
  const github = createGitHubConnector();
  registry.set(github.kind, github);
  const linear = createLinearConnector();
  registry.set(linear.kind, linear);
  return registry;
}

export function registerConnector(
  registry: ConnectorRegistry,
  connector: SourceConnector,
): void {
  registry.set(connector.kind, connector);
}
