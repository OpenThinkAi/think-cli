import path from 'node:path';
import { Command } from 'commander';

/**
 * `think serve` boots the proxy that fans external events into engrams.
 *
 * The serve module (hono / @hono/node-server / zod / scheduler / vault)
 * is **lazy-imported** from inside the action handler so users who never
 * run `serve` don't pay the cold-start cost on hot paths like `think log`
 * and `think recall`. Bundle size still grows by the proxy's deps; only
 * startup latency for non-serve commands is protected.
 *
 * All knobs are env-driven (`THINK_TOKEN`, `THINK_VAULT_KEY`, `PORT`,
 * `THINK_DB_PATH`, `THINK_POLL_INTERVAL_SECONDS`, `NODE_ENV`) — that's
 * load-bearing for Railway / docker-compose deployments where flags don't
 * survive container restarts. Defaults: PORT=4823, poll=600s.
 *
 * One exception: `--peer-id <value>` (AGT-385) is a flag rather than an
 * env var because (a) the value is persisted to sqlite on first
 * presentation, so subsequent restarts without the flag still pick it up,
 * and (b) operators only set it once for a "fixed name" deployment — a
 * persistent env-var in compose config would conflict with the persisted
 * value on every restart.
 */
export const serveCommand = new Command('serve')
  .description('Boot the open-think proxy server (env-driven; see `docs/serve.md`)')
  .option(
    '--peer-id <value>',
    'Override the persisted proxy peer-id (one-time setter; the value is persisted to sqlite). For ' +
      'fixed-name deployments such as `proxy-anglepoint`. Leave unset to reuse the persisted value or ' +
      'auto-generate on first boot.',
  )
  .action(async (opts: { peerId?: string }) => {
    const { runServe } = await import('../serve/boot-entry.js');
    await runServe({ peerIdOverride: opts.peerId });
  });

/**
 * Resolves the sqlite DB path the running proxy would use. Mirrors
 * `runServe()` in `boot-entry.ts`: `THINK_DB_PATH` if set, otherwise
 * `./open-think.sqlite` relative to the cwd. `:memory:` is treated as
 * a sentinel.
 *
 * Centralised here so every `serve` subcommand reads the same path the
 * server writes to — divergence here means an admin command would
 * silently operate on a different DB than the running proxy.
 */
function resolveDbPath(): string {
  const raw = process.env.THINK_DB_PATH ?? './open-think.sqlite';
  return raw === ':memory:' ? raw : path.resolve(raw);
}

serveCommand
  .command('status')
  .description(
    'Print the persisted proxy state (peer-id, db path, active subscriptions) without starting the ' +
      'server. Reads the same sqlite DB `think serve` writes to.',
  )
  .action(async () => {
    // Lazy-import to keep the hot CLI path free of the `node:sqlite` cost
    // for users who never run the proxy.
    const { openDb } = await import('../serve/db.js');
    const { readProxyPeerId } = await import('../serve/peer-id.js');
    const { listSubscriptionsByKind } = await import('../serve/admin.js');

    const DB_PATH = resolveDbPath();
    const db = openDb(DB_PATH);
    try {
      const peerId = readProxyPeerId(db);
      console.log(`db path:        ${DB_PATH}`);
      // `(unset — will auto-generate on first boot)` rather than empty so a
      // sysadmin reading the output doesn't think the field is broken.
      console.log(`proxy peer-id:  ${peerId ?? '(unset — will auto-generate on first boot)'}`);

      // Subscription listing grouped by connector kind (AGT-388 AC #4).
      // Empty state is signalled explicitly — silence after the header
      // would look like a bug to a sysadmin reading the output.
      const grouped = listSubscriptionsByKind(db);
      const kinds = Object.keys(grouped);
      console.log('subscriptions:');
      if (kinds.length === 0) {
        console.log('  (none)');
      } else {
        for (const kind of kinds) {
          console.log(`  ${kind}:`);
          for (const sub of grouped[kind]) {
            const lastPolled = sub.last_polled_at ?? 'never';
            console.log(
              `    - ${sub.pattern}  (id=${sub.id}, created=${sub.created_at}, last_polled=${lastPolled})`,
            );
          }
        }
      }
    } finally {
      db.close();
    }
  });

serveCommand
  .command('subscribe')
  .description('Add a connector subscription to the running proxy. The scheduler picks it up on its next tick.')
  .argument('<kind>', 'Connector kind, e.g. `github`')
  .argument('<pattern>', 'Source pattern; for github this is `<owner>/<repo>`')
  .action(async (kind: string, pattern: string) => {
    const { openDb } = await import('../serve/db.js');
    const { addSubscription } = await import('../serve/admin.js');
    const { buildDefaultRegistry } = await import('../serve/connectors/registry.js');

    const DB_PATH = resolveDbPath();
    const db = openDb(DB_PATH);
    try {
      const result = addSubscription(db, kind, pattern);
      if (result.created) {
        console.log(
          `subscribed: kind=${kind} pattern=${pattern} (id=${result.subscription.id})`,
        );
      } else {
        console.log(
          `already subscribed: kind=${kind} pattern=${pattern} (id=${result.subscription.id})`,
        );
      }
      // Warn loudly when the kind has no registered connector. The row
      // gets created either way (so it persists across a future plugin
      // install), but without this hint the scheduler's per-tick warning
      // lands in server logs the operator may never see.
      const registry = buildDefaultRegistry();
      if (!registry.has(kind)) {
        console.warn(
          `warning: kind '${kind}' has no registered connector — subscription created but will not be polled until a matching connector is installed.`,
        );
      }
      // Reminder hints for kinds that actually need a credential. The
      // mock connector ignores credentials so we stay quiet for it. The
      // env-var name follows the `$THINK_<KIND>_PAT` convention enforced
      // by `creds add` (see kind-specific env lookup below).
      if (kind === 'github') {
        console.log(
          `note: add a PAT with \`think serve creds add github ${pattern}\` (reads from stdin or $THINK_GITHUB_PAT).`,
        );
      } else if (kind === 'linear') {
        console.log(
          `note: add a Linear personal API key with \`think serve creds add linear ${pattern}\` (reads from stdin or $THINK_LINEAR_PAT). Generate one at https://linear.app/settings/account/security.`,
        );
      }
    } finally {
      db.close();
    }
  });

serveCommand
  .command('unsubscribe')
  .description('Remove a subscription from the running proxy. The next scheduler tick stops polling it.')
  .argument('<kind>', 'Connector kind, e.g. `github`')
  .argument('<pattern>', 'Source pattern, e.g. `<owner>/<repo>` for github')
  .action(async (kind: string, pattern: string) => {
    const { openDb } = await import('../serve/db.js');
    const { removeSubscription } = await import('../serve/admin.js');

    const DB_PATH = resolveDbPath();
    const db = openDb(DB_PATH);
    try {
      const removed = removeSubscription(db, kind, pattern);
      if (removed === null) {
        // Soft-fail (exit 1) rather than throw so the message reads
        // cleanly without a stacktrace, but the non-zero exit lets
        // shell scripts detect the no-op.
        console.error(`no subscription found for kind=${kind} pattern=${pattern}`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `unsubscribed: kind=${kind} pattern=${pattern} (id=${removed.id}; events and credential cascaded)`,
      );
    } finally {
      db.close();
    }
  });

const credsCommand = serveCommand
  .command('creds')
  .description('Manage encrypted source credentials stored in the proxy vault.');

credsCommand
  .command('add')
  .description(
    'Store (or replace) a credential for the subscription matching <kind>/<pattern>. ' +
      'Reads from the kind-specific env var (e.g. $THINK_GITHUB_PAT for github), ' +
      'then $THINK_CRED_PLAINTEXT, or stdin.',
  )
  .argument('<kind>', 'Connector kind')
  .argument('<pattern>', 'Subscription pattern, e.g. `<owner>/<repo>` for github')
  .action(async (kind: string, pattern: string) => {
    const { openDb } = await import('../serve/db.js');
    const { createVault } = await import('../serve/vault/index.js');
    const { loadVaultKey } = await import('../serve/vault/key.js');
    const { setSubscriptionCredential } = await import('../serve/admin.js');

    // PAT source order: kind-specific env var first (e.g. THINK_GITHUB_PAT),
    // then generic THINK_CRED_PLAINTEXT (used by tests and for piping from
    // another secret manager), finally stdin. Stdin is the most operator-
    // friendly path interactively but the env paths are essential for
    // automated pipelines that can't drive a TTY.
    const envName = `THINK_${kind.toUpperCase()}_PAT`;
    let plaintext: string | undefined =
      process.env[envName] ?? process.env.THINK_CRED_PLAINTEXT;
    if (plaintext === undefined || plaintext === '') {
      plaintext = await readStdinTrimmed();
    }
    if (!plaintext || plaintext.length === 0) {
      console.error(
        `creds add: no credential provided. Set $${envName} or pipe the value on stdin.`,
      );
      process.exitCode = 1;
      return;
    }

    const DB_PATH = resolveDbPath();
    const db = openDb(DB_PATH);
    try {
      const vaultKey = loadVaultKey();
      const vault = createVault(vaultKey);
      const subId = setSubscriptionCredential(db, vault, kind, pattern, plaintext);
      console.log(
        `credential stored for kind=${kind} pattern=${pattern} (id=${subId})`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Defense in depth: scrub the plaintext from the message in case
      // the underlying error surfaced it. Vault and admin layers don't
      // include the plaintext, but a future contributor might.
      console.error(`creds add failed: ${message.replace(plaintext!, '***')}`);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  });

/**
 * Reads stdin to EOF and returns the trimmed contents, or `undefined` if
 * stdin was a TTY (no piped input). Used by `creds add` for the operator
 * who pipes a PAT via `cat token.txt | think serve creds add github octo/widget`.
 *
 * TTY check avoids hanging when run without piped input.
 */
async function readStdinTrimmed(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}
