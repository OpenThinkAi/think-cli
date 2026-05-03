import { VAULT_KEY_ENV } from './vault/key.js';

/**
 * Boot-time env validation, extracted from `index.ts` so it can be unit-tested.
 *
 * `runBootGuards` is fail-fast: it throws on the first violation rather
 * than collecting them all. `index.ts` catches and exits 1 with a clear
 * message; tests assert on the throw without spawning a subprocess.
 *
 * The production gate (AGT-029 AC #6) follows the standard Node convention
 * of `NODE_ENV=production`; every other knob in this package uses the
 * `THINK_*` prefix, but `NODE_ENV` is the industry-standard "are we in prod"
 * flag and the inconsistency is bounded to this one variable.
 */

export interface BootConfig {
  port: number;
  pollIntervalSeconds: number;
}

const DEFAULT_PORT = 3000;
const DEFAULT_POLL_INTERVAL_SECONDS = 600;

export class BootGuardError extends Error {}

export function runBootGuards(env: NodeJS.ProcessEnv): BootConfig {
  if (!env.THINK_TOKEN) {
    throw new BootGuardError(
      'THINK_TOKEN env var is required (gates /v1/events, /v1/subscriptions, and /v1/subscriptions/:id/credential)',
    );
  }

  // Production gate: per AGT-029 AC #6, refuse to start in production
  // without the vault key. Dev (NODE_ENV unset, 'development', 'test',
  // anything-not-production) falls through to the dev-path file at
  // `~/.openthink/vault.key` inside `loadVaultKey`.
  if (env.NODE_ENV === 'production' && !env[VAULT_KEY_ENV]) {
    throw new BootGuardError(
      `${VAULT_KEY_ENV} env var is required when NODE_ENV=production ` +
        `(base64-encoded 32-byte key for the source credential vault)`,
    );
  }

  const port = parsePort(env.PORT);
  const pollIntervalSeconds = parsePollInterval(env.THINK_POLL_INTERVAL_SECONDS);

  return { port, pollIntervalSeconds };
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new BootGuardError(`PORT must be an integer 1–65535, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parsePollInterval(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_POLL_INTERVAL_SECONDS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new BootGuardError(
      `THINK_POLL_INTERVAL_SECONDS must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}
