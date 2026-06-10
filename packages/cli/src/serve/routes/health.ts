import { Hono } from 'hono';
import { VERSION } from '../version.js';
import { getPushDebouncerMetrics } from '../../daemon/push-debouncer.js';

export const health = new Hono();

health.get('/v1/health', (c) => {
  // Liveness + lightweight observability. The `version` field lets curious
  // operators distinguish daemon builds without consulting the registry.
  // `push_debouncer` surfaces AGT-478 AC #5: permanent non-fast-forward push
  // failures are visible here without scraping daemon.log directly. A rising
  // `failures_nff` counter means the proxy is curating but curated entries are
  // not reaching origin — the operator should check the clone's `git status`
  // and consider the last-resort `git reset --hard origin/<branch>` escape hatch
  // documented in the runbook.
  const pdm = getPushDebouncerMetrics();
  return c.json({
    status: 'ok',
    version: VERSION,
    push_debouncer: {
      failures_nff: pdm.pushFailuresNonFastForward,
      successes: pdm.pushSuccesses,
      last_failure_at: pdm.lastPushErrorAt,
    },
  });
});
