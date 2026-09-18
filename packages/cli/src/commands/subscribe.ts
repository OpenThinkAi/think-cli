import { Command, Option } from 'commander';
import chalk from 'chalk';
import { getConfig, saveConfig, type SubscriptionsConfig } from '../lib/config.js';
import { parseSelector } from '../lib/subscribe-redact.js';
import {
  ProxyError,
  createSubscription,
  listSubscriptions,
  deleteSubscription,
  setCredential,
  testCredential,
  type ProxyConfig,
} from '../lib/proxy-client.js';
import {
  installAgent as installSubscribeAgent,
  uninstallAgent as uninstallSubscribeAgent,
  getAgentStatus as getSubscribeAgentStatus,
  getLogPath as getSubscribeLogPath,
} from '../lib/auto-subscribe.js';

export const subscribeCommand = new Command('subscribe')
  .description('Subscribe to external event sources via the open-think proxy');

function fail(msg: string): never {
  console.error(chalk.red(msg));
  process.exit(1);
}

function getProxyConfig(): ProxyConfig {
  const sub = getConfig().subscriptions;
  if (!sub || !sub.proxyUrl || !sub.token) {
    fail('subscribe: no proxy configured. Run `think subscribe configure --proxy <url>` first.');
  }
  return { proxyUrl: sub.proxyUrl, token: sub.token };
}

function rewriteSubscriptions(mutate: (sub: SubscriptionsConfig | undefined) => SubscriptionsConfig): void {
  const cfg = getConfig();
  cfg.subscriptions = mutate(cfg.subscriptions);
  saveConfig(cfg);
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Read a secret from a TTY without echoing it. Set raw mode, accumulate
 * bytes until <CR>/<LF>, swallow them, restore cooked mode. Mirrors the
 * pattern used by ssh-agent / git askpass on Unix; Windows is best-effort
 * (the docs steer users to the stdin path on platforms where raw mode is
 * unreliable).
 */
function promptHidden(prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('promptHidden requires a TTY'));
      return;
    }
    process.stderr.write(prompt);
    const buf: string[] = [];
    const wasRaw = stdin.isRaw;
    try {
      stdin.setRawMode(true);
    } catch (err) {
      reject(err);
      return;
    }
    stdin.resume();
    stdin.setEncoding('utf-8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.removeListener('data', onData);
          try {
            stdin.setRawMode(wasRaw);
          } catch {
            /* best-effort */
          }
          stdin.pause();
          process.stderr.write('\n');
          resolve(buf.join(''));
          return;
        }
        if (ch === '\x03') {
          // Ctrl-C: restore tty + propagate
          stdin.removeListener('data', onData);
          try {
            stdin.setRawMode(wasRaw);
          } catch {
            /* best-effort */
          }
          stdin.pause();
          process.stderr.write('\n');
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\x7f' || ch === '\b') {
          if (buf.length > 0) buf.pop();
          continue;
        }
        buf.push(ch);
      }
    };
    stdin.on('data', onData);
  });
}

// `think subscribe configure --proxy <url> [--token <token>]`
// Token defaults to stdin (or the THINK_TOKEN env var) so the secret stays
// out of shell history.
subscribeCommand.addCommand(new Command('configure')
  .description('Set the proxy URL and bearer token used by other subscribe commands')
  .requiredOption('--proxy <url>', 'Base URL of the open-think proxy (http or https; no trailing slash needed)')
  .option('--token <token>', 'Bearer token (NOT recommended — leaks to shell history; prefer stdin or THINK_TOKEN env)')
  .action(async (opts: { proxy: string; token?: string }) => {
    let parsed: URL;
    try {
      parsed = new URL(opts.proxy);
    } catch {
      fail(`subscribe configure: --proxy must be a valid URL (got ${JSON.stringify(opts.proxy)})`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      fail(`subscribe configure: --proxy must use http or https (got ${parsed.protocol})`);
    }

    let token = opts.token?.trim() ?? '';
    if (!token) {
      const envToken = process.env.THINK_TOKEN?.trim();
      if (envToken) {
        token = envToken;
      } else if (process.stdin.isTTY) {
        try {
          token = (await promptHidden('Bearer token (input hidden): ')).trim();
        } catch (err) {
          fail(`subscribe configure: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        token = (await readAllStdin()).trim();
      }
    }
    if (!token) {
      fail('subscribe configure: token is empty (provide via --token, THINK_TOKEN env, or stdin)');
    }
    rewriteSubscriptions((existing) => ({
      proxyUrl: opts.proxy,
      token,
      cursors: existing?.cursors,
    }));
    console.log(chalk.green('✓') + ` Proxy configured: ${parsed.origin}`);
  }));

// `think subscribe add <kind> <pattern>`
subscribeCommand.addCommand(new Command('add')
  .description('Create a subscription on the proxy (e.g. `think subscribe add mock 3`)')
  .argument('<kind>', 'Source kind (today only `mock` is registered; github/linear/... land in follow-ups)')
  .argument('<pattern>', 'Pattern the connector understands (kind-specific)')
  .option('--accept-data-flow', 'Acknowledge that ingested events flow into the proxy-side curator (and to Anthropic if curator consent is granted). Required for non-interactive use; interactive sessions get a y/N prompt instead.')
  .action(async (kind: string, pattern: string, opts: { acceptDataFlow?: boolean }) => {
    // AGT-066 AC #1: explicit acknowledgment that third-party events
    // (commenter words, ticket bodies, webhook payloads) will flow through
    // the proxy's curator into the team cortex. Friction is the point.
    const acknowledged = opts.acceptDataFlow ?? (await promptDataFlowConsent(kind, pattern));
    if (!acknowledged) {
      console.error(chalk.red('subscribe add: declined; no subscription created.'));
      process.exitCode = 1;
      return;
    }

    const proxy = getProxyConfig();
    try {
      const sub = await createSubscription(proxy, kind, pattern);
      console.log(chalk.green('✓') + ` Created subscription`);
      console.log(`  ${chalk.cyan('id:')}      ${sub.id}`);
      console.log(`  ${chalk.cyan('kind:')}    ${sub.kind}`);
      console.log(`  ${chalk.cyan('pattern:')} ${sub.pattern}`);
      console.log(chalk.dim(`  Configure per-subscription redact selectors with:`));
      console.log(chalk.dim(`    think subscribe redact-set ${sub.id} '$.user.email' '$.headers.x-real-ip'`));
    } catch (err) {
      if (err instanceof ProxyError) fail(`subscribe add: ${err.message}`);
      throw err;
    }
  }));

async function promptDataFlowConsent(kind: string, pattern: string): Promise<boolean> {
  // Non-interactive (CI, scripts, automation): refuse with a clear pointer
  // to --accept-data-flow. Interactive sessions get a y/N prompt.
  if (!process.stdin.isTTY) {
    console.error(chalk.red(`subscribe add: non-interactive session and --accept-data-flow not set.`));
    console.error(chalk.red(`Re-run with: think subscribe add ${kind} ${pattern} --accept-data-flow`));
    return false;
  }

  console.log(chalk.yellow(`Heads up: this subscription will pull events from a ${kind} source authored by other people`));
  console.log(chalk.yellow(`(commenters, ticket authors, webhook senders). Each event lands locally and`));
  console.log(chalk.yellow(`flows through curation — if curator consent is granted (THINK_LLM_CONSENT or`));
  console.log(chalk.yellow(`cortex.llmConsent), that content reaches Anthropic.`));
  console.log();
  console.log(chalk.dim(`Baseline PII strip (email, GPG, IP headers, phone) runs at ingestion. Per-subscription`));
  console.log(chalk.dim(`redact selectors can be added later via 'think subscribe redact-set'.`));
  console.log();

  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('Acknowledge and create the subscription? [y/N] ', (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// `think subscribe list`
subscribeCommand.addCommand(new Command('list')
  .description('List subscriptions registered on the proxy')
  .action(async () => {
    const proxy = getProxyConfig();
    try {
      const subs = await listSubscriptions(proxy);
      if (subs.length === 0) {
        console.log(chalk.dim('No subscriptions. `think subscribe add <kind> <pattern>` to create one.'));
        return;
      }
      const widthId = Math.max(2, ...subs.map((s) => s.id.length));
      const widthKind = Math.max(4, ...subs.map((s) => s.kind.length));
      const widthPattern = Math.max(7, ...subs.map((s) => s.pattern.length));
      console.log(`${'id'.padEnd(widthId)}  ${'kind'.padEnd(widthKind)}  ${'pattern'.padEnd(widthPattern)}  last_polled_at`);
      for (const s of subs) {
        const last = s.last_polled_at ?? '(never)';
        console.log(`${s.id.padEnd(widthId)}  ${s.kind.padEnd(widthKind)}  ${s.pattern.padEnd(widthPattern)}  ${last}`);
      }
    } catch (err) {
      if (err instanceof ProxyError) fail(`subscribe list: ${err.message}`);
      throw err;
    }
  }));

// `think subscribe remove <id>`
subscribeCommand.addCommand(new Command('remove')
  .description('Delete a subscription on the proxy (cascades to events/credential)')
  .argument('<id>', 'Subscription id from `subscribe list`')
  .action(async (id: string) => {
    const proxy = getProxyConfig();
    try {
      await deleteSubscription(proxy, id);
      // Drop the local cursor too — the id is gone. We're guaranteed to
      // have a populated `existing` here because getProxyConfig() above
      // succeeded; treat absence as a real bug rather than silently
      // installing a blank-string config.
      rewriteSubscriptions((existing) => {
        if (!existing) {
          throw new Error('subscriptions config vanished mid-call (unreachable)');
        }
        const cursors = { ...(existing.cursors ?? {}) };
        delete cursors[id];
        return { ...existing, cursors };
      });
      console.log(chalk.green('✓') + ` Removed subscription ${id}`);
    } catch (err) {
      if (err instanceof ProxyError) fail(`subscribe remove: ${err.message}`);
      throw err;
    }
  }));

// `think subscribe set-credential <id>` — read from stdin or hidden TTY prompt
subscribeCommand.addCommand(new Command('set-credential')
  .description('Store an encrypted credential for a subscription (stdin preferred)')
  .argument('<id>', 'Subscription id from `subscribe list`')
  .action(async (id: string) => {
    const proxy = getProxyConfig();
    let credential: string;
    if (process.stdin.isTTY) {
      try {
        credential = (await promptHidden(`Credential for ${id} (input hidden): `)).trim();
      } catch (err) {
        fail(`subscribe set-credential: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      credential = (await readAllStdin()).trim();
    }
    if (!credential) {
      fail('subscribe set-credential: credential is empty (read 0 bytes)');
    }
    try {
      await setCredential(proxy, id, credential);
    } catch (err) {
      if (err instanceof ProxyError) fail(`subscribe set-credential: ${err.message}`);
      throw err;
    }
    console.log(chalk.green('✓') + ` Credential stored for ${id} (encrypted at rest in the proxy vault).`);

    // Verify against the source so the success message isn't a lie. The
    // proxy returns 501 when the connector has no `verifyCredential` —
    // that's not a failure, just "can't verify here."
    try {
      const result = await testCredential(proxy, id);
      if (result.ok) {
        console.log(chalk.dim('  Verified against source: ok'));
      } else {
        console.log(chalk.yellow(`  ⚠ Verify failed: ${result.detail ?? '(no detail)'}`));
        console.log(chalk.dim(`    Credential is stored; fix and re-run \`think subscribe set-credential ${id}\`.`));
      }
    } catch (err) {
      if (err instanceof ProxyError && err.status === 501) {
        console.log(chalk.dim('  Connector does not support credential verification; stored without test.'));
      } else if (err instanceof ProxyError) {
        console.log(chalk.yellow(`  ⚠ Verify call failed: ${err.message}`));
      } else {
        throw err;
      }
    }
  }));

// `think subscribe poll [--quiet]`
subscribeCommand.addCommand(new Command('poll')
  .description('[DEPRECATED] No-op — use `think pull <team-cortex>` instead')
  .option('--quiet', 'Suppress the deprecation notice. Used by the LaunchAgent so a backgrounded poll stays silent.')
  // think-3 (AGT-1303): --legacy-engrams drove the pre-think-proxy-events
  // local engram-write path. The engram tier is gone, so the flag is kept
  // registered-but-hidden (rather than dropped outright) purely so passing it
  // gets our own one-line removal note instead of commander's generic
  // "unknown option" — same pattern as the removed `think sync` fields
  // (AGT-1297). It always exits non-zero, even under --quiet.
  .addOption(new Option('--legacy-engrams', 'Removed — use `think pull <team-cortex>`').hideHelp())
  .action((opts: { quiet?: boolean; legacyEngrams?: boolean }) => {
    // Checked first and unconditionally, before --quiet is read: a silent
    // no-op here would look like a successful ingest to a scheduler.
    if (opts.legacyEngrams !== undefined) {
      process.stderr.write('error: --legacy-engrams has been removed along with the engram tier; use `think pull <team-cortex>` instead\n');
      process.exitCode = 1;
      return;
    }

    // think-proxy-events (AGT-389): the proxy curates centrally and publishes
    // memories to the team cortex; team members just pull.
    if (!opts.quiet) {
      console.log(chalk.yellow('[subscribe poll] deprecated:') + ' external events are now team-shared via the proxy-curated team cortex.');
      console.log(chalk.dim('  Replacement: `think pull <team-cortex>` (just like any other cortex).'));
    }
  }));

// `think subscribe install-agent`
subscribeCommand.addCommand(new Command('install-agent')
  .description('Install a LaunchAgent that polls in the background (default 600s)')
  .option('--interval <seconds>', 'Scheduler cadence in seconds (default 600)', (v) => {
    const n = parseInt(v, 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== v.trim()) {
      console.error(chalk.red(`--interval must be a positive integer (got: '${v}')`));
      process.exit(1);
    }
    return n;
  })
  .action((opts: { interval?: number }) => {
    try {
      const { label, plistPath } = installSubscribeAgent({ intervalSeconds: opts.interval });
      const intervalLabel = opts.interval ?? 600;
      console.log(chalk.green('✓') + ` Auto-subscribe enabled (every ${intervalLabel}s)`);
      console.log(chalk.dim(`  Label: ${label}`));
      console.log(chalk.dim(`  Plist: ${plistPath}`));
      if (process.env.THINK_HOME) {
        console.log(chalk.dim(`  THINK_HOME: ${process.env.THINK_HOME}`));
      }
      console.log(chalk.dim(`  First run fires immediately; tail the log to watch:`));
      console.log(chalk.dim(`    tail -f ${getSubscribeLogPath()}`));
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  }));

// `think subscribe disable`
subscribeCommand.addCommand(new Command('disable')
  .description('Remove the auto-subscribe LaunchAgent for this workspace')
  .action(() => {
    const { removed, plistPath } = uninstallSubscribeAgent();
    if (removed) {
      console.log(chalk.green('✓') + ` Auto-subscribe disabled (${plistPath})`);
    } else {
      console.log(chalk.dim(`No auto-subscribe agent installed (${plistPath})`));
    }
  }));

// `think subscribe status`
subscribeCommand.addCommand(new Command('status')
  .description('Show auto-subscribe scheduler status')
  .action(() => {
    const s = getSubscribeAgentStatus();
    console.log(`Label:     ${chalk.cyan(s.label)}`);
    console.log(`Installed: ${s.installed ? chalk.green('yes') : chalk.dim('no')}`);
    console.log(`Loaded:    ${s.loaded ? chalk.green('yes') : chalk.dim('no')}`);
    if (s.intervalSeconds) {
      console.log(`Interval:  ${s.intervalSeconds}s`);
    }
    console.log(`Plist:     ${s.plistPath}`);
    if (s.lastRunAt) {
      console.log(`Last log entry:  ${s.lastRunAt.toISOString()}`);
    } else {
      console.log(`Last log entry:  ${chalk.dim('(no log file yet)')}`);
    }
  }));

// `think subscribe show` — print the configured proxy (token redacted)
subscribeCommand.addCommand(new Command('show')
  .description('Show the configured proxy URL (token is redacted)')
  .action(() => {
    const { subscriptions } = getConfig();
    if (!subscriptions || !subscriptions.proxyUrl || !subscriptions.token) {
      // Both URL and token are required for any subscribe operation;
      // showing one without the other would imply a working configuration.
      console.log(chalk.dim('No proxy configured. Run `think subscribe configure --proxy <url>`.'));
      return;
    }
    console.log(`Proxy: ${chalk.cyan(subscriptions.proxyUrl)}`);
    console.log(`Token: ${chalk.dim('(redacted)')}`);
    const cursors = subscriptions.cursors ?? {};
    const cursorIds = Object.keys(cursors);
    if (cursorIds.length > 0) {
      console.log(`Cursors:`);
      for (const id of cursorIds) console.log(`  ${id}: ${cursors[id]}`);
    } else {
      console.log(`Cursors: ${chalk.dim('(none)')}`);
    }
    // Print "(none)" when no selectors are configured so the redact
    // surface is discoverable from `show` even before any are set —
    // mirrors the cursors empty-case for parity. AGT-066 follow-up.
    const redact = subscriptions.redact ?? {};
    const redactIds = Object.keys(redact);
    if (redactIds.length > 0) {
      console.log(`Redact selectors:`);
      for (const id of redactIds) console.log(`  ${id}: ${(redact[id] ?? []).join(', ')}`);
    } else {
      console.log(`Redact selectors: ${chalk.dim('(none)')}`);
    }
  }));

// `think subscribe redact-set <id> <path1> [path2...]` (AGT-066 AC #3)
//
// Per-subscription JSONPath-subset selectors applied during `poll` after
// the baseline PII strip. Selector format: `$.a.b.c` or `a.b.c`. Pass
// zero paths after the id to clear all selectors for that subscription.
subscribeCommand.addCommand(new Command('redact-set')
  .description('Set per-subscription JSONPath-subset redact selectors (e.g. `$.user.email`)')
  .argument('<id>', 'Subscription id (from `think subscribe list`)')
  .argument('[paths...]', 'JSONPath-subset selectors. Pass zero to clear all selectors for this subscription.')
  .action((id: string, paths: string[]) => {
    // Validate every selector at config-write time so a typo is caught
    // here rather than silently swallowed at poll time.
    const invalid: string[] = [];
    for (const p of paths) {
      if (parseSelector(p) === null) invalid.push(p);
    }
    if (invalid.length > 0) {
      console.error(chalk.red(`subscribe redact-set: invalid selector${invalid.length === 1 ? '' : 's'}:`));
      for (const p of invalid) console.error(chalk.red(`  ${p}`));
      console.error(chalk.dim(`Supported syntax: \`$.a.b.c\` or \`a.b.c\` — no array indices, wildcards, or filters.`));
      process.exitCode = 1;
      return;
    }

    rewriteSubscriptions((existing) => {
      if (!existing) {
        // No subscriptions config at all means the user hasn't run
        // `subscribe configure` — surface that instead of writing a
        // half-shaped config row that would later confuse `getProxyConfig`.
        throw new Error('No subscriptions config. Run `think subscribe configure --proxy <url>` first.');
      }
      const redact = { ...(existing.redact ?? {}) };
      if (paths.length === 0) {
        delete redact[id];
      } else {
        redact[id] = paths;
      }
      return { ...existing, redact };
    });

    if (paths.length === 0) {
      console.log(chalk.green('✓') + ` Cleared redact selectors for ${id}`);
    } else {
      console.log(chalk.green('✓') + ` Set ${paths.length} redact selector${paths.length === 1 ? '' : 's'} for ${id}:`);
      for (const p of paths) console.log(`  ${p}`);
    }
  }));

