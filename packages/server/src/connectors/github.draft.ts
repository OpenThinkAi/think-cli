// =============================================================================
// DRAFT — interface placeholder for the future GitHub connector (AGT-029+).
//
// Why this file exists: keeps the SourceConnector contract honest. If the
// interface signature changes, tsc fails here and the design narrative is
// forced to update alongside it. The actual rate-limit / ETag / multi-
// endpoint design lives in:
//
//   packages/server/docs/design/connectors-github.md
//
// This file is NOT registered, NOT shipped (tree-shaken out of dist/), and
// NOT invoked. Calling poll() throws — the live implementation lands when
// AGT-029 wires credential storage and fetches.
// =============================================================================

import type { PollContext, PollResult, SourceConnector } from './types.js';

/** Per-endpoint cursor shape — see docs/design/connectors-github.md. */
export interface GitHubEndpointCursor {
  etag?: string;
  lastModified?: string;
  since?: string;
}

/** Subscription-wide cursor: a map keyed by full path including query. */
export interface GitHubCursor {
  endpoints: Record<string, GitHubEndpointCursor>;
}

const NOT_IMPLEMENTED =
  'github connector is a design placeholder — see packages/server/docs/design/connectors-github.md';

export class GitHubConnectorDraft implements SourceConnector<GitHubCursor> {
  readonly kind = 'github';

  async poll(_ctx: PollContext<GitHubCursor>): Promise<PollResult<GitHubCursor>> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
