import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig, saveConfig, type Config, type LlmProviderConfig } from '../lib/config.js';
import { isValidProxyUrl } from '../lib/proxy-url.js';

/**
 * Keys think-3 (AGT-1303) stopped reading when the engram write tier was
 * removed. Every one was read only by `think curate` or its prompt assembler.
 *
 * They stay settable on purpose: a script or shell history that still sets one
 * must keep exiting 0 (AC6 — note, don't fail). ALLOWED_KEYS is *derived* from
 * this set below rather than repeating the names, because a key listed here
 * but missing there would be rejected with "Unknown config key" before the
 * advisory could run — turning AC6's "note, don't fail" into exactly the
 * failure it forbids. Deriving makes that drift unrepresentable; the
 * behaviour for every key is pinned in tests/commands/config-retired-keys.test.ts.
 */
const RETIRED_KEYS = new Set([
  'cortex.curateEveryN',
  'cortex.engramTTLDays',
  'cortex.curatorPromptCharCap',
  'cortex.selectivity',
  'cortex.granularity',
  'cortex.maxMemoriesPerRun',
  'cortex.confirmBeforeCommit',
  'cortex.idleWindowMinutes',
  'cortex.staleWindowMinutes',
]);

/** Keys something still reads. */
const LIVE_KEYS = [
  'cortex.author',
  'cortex.repo',
  'cortex.active',
  'cortex.retroRelegateAfterRuns',
  'cortex.curationIntervalHours',
  'cortex.retroMinLength',
  'cortex.retroNearDupThreshold',
  // Real key for LLM-consent (AGT-1327) — despite living next to `cortex.llm`
  // in the docs prose, it is NOT nested under it: `llmConsent` is a sibling
  // field on CortexConfig (lib/config.ts), read by `hasLlmConsent()`
  // (lib/llm-consent.ts). It fits the plain flat-key path unchanged.
  'cortex.llmConsent',
  'paused',
  'proxy.url',
  'search.engine',
];

/**
 * Everything `think config set` accepts: the live keys, plus the retired ones
 * — which are accepted-with-a-note rather than rejected.
 */
const ALLOWED_KEYS = new Set([...LIVE_KEYS, ...RETIRED_KEYS]);

/** Keys whose values must be one of a known enum. Checked at set time. */
const ENUM_KEYS: Record<string, string[]> = {
  'search.engine': ['brute-force', 'sqlite-vec'],
};

/** Keys whose values must be exactly "true" or "false". Checked at set time. */
const BOOLEAN_KEYS = new Set(['cortex.llmConsent']);

/**
 * Keys that require a daemon restart to take effect. A note is printed
 * after a successful write.
 */
const DAEMON_RESTART_KEYS = new Set(['proxy.url', 'cortex.curationIntervalHours']);

// ---------------------------------------------------------------------------
// cortex.llm.* — provider registry keys (AGT-1327)
//
// `cortex.llm` (lib/config.ts `LlmConfig`) is a small nested object, not a
// flat key: a `providers` map (each entry an `LlmProviderConfig`), `default`,
// `operations`, and `fallback`. It doesn't fit ALLOWED_KEYS, which only ever
// matched exact dotted keys — hence AGT-1327 ("Unknown config key" on
// `cortex.llm.providers.<name>.model`, which forced a hand-edit of
// config.json on the work Mac). This block handles JUST the two shapes the
// ticket asks for: a provider's leaves, and `cortex.llm.fallback`.
// `cortex.llm.default` and `cortex.llm.operations.<op>` are deliberately out
// of scope — not in the ticket's acceptance criteria — and still error with
// "Unknown config key" below, same as before.
// ---------------------------------------------------------------------------

/** Every leaf `LlmProviderConfig` (lib/config.ts) actually defines. */
const LLM_PROVIDER_LEAVES = [
  'kind',
  'endpoint',
  'model',
  'apiKey',
  'apiKeyEnv',
  'offMachine',
  'ctxBudget',
  'timeoutMs',
  'disableThinking',
] as const;

type LlmProviderLeaf = (typeof LLM_PROVIDER_LEAVES)[number];

/**
 * Compile-time tripwire: if `LlmProviderConfig` gains or loses a field
 * without this list being updated to match, this line stops type-checking.
 * "Enumerate from the type, don't guess" (AGT-1327) — this makes drift
 * between the two unrepresentable instead of trusting someone to notice.
 */
type _LlmProviderLeavesExhaustive =
  Exclude<keyof LlmProviderConfig, LlmProviderLeaf> extends never
    ? true
    : ['add the missing leaf(s) to LLM_PROVIDER_LEAVES:', Exclude<keyof LlmProviderConfig, LlmProviderLeaf>];
const _llmProviderLeavesExhaustive: _LlmProviderLeavesExhaustive = true;
void _llmProviderLeavesExhaustive;

const LLM_KIND_VALUES = ['openai', 'anthropic'] as const;

const LLM_PROVIDER_KEY_RE = /^cortex\.llm\.providers\.([^.]+)\.([^.]+)$/;

type CortexLlmKey =
  | { kind: 'fallback' }
  | { kind: 'provider'; name: string; leaf: LlmProviderLeaf };

/**
 * Recognise a `cortex.llm.*` key this command supports, or return `null` for
 * anything else under that prefix (unknown leaf, missing leaf, `default`,
 * `operations.<op>`, etc.) — callers turn `null` into "Unknown config key".
 */
function parseCortexLlmKey(key: string): CortexLlmKey | null {
  if (key === 'cortex.llm.fallback') return { kind: 'fallback' };
  const match = key.match(LLM_PROVIDER_KEY_RE);
  if (!match) return null;
  const [, name, leaf] = match;
  if (!(LLM_PROVIDER_LEAVES as readonly string[]).includes(leaf)) return null;
  return { kind: 'provider', name, leaf: leaf as LlmProviderLeaf };
}

function describeLlmAcceptedLeaves(): string {
  return `cortex.llm.fallback, cortex.llm.providers.<name>.{${LLM_PROVIDER_LEAVES.join(',')}}`;
}

/** Generic nested-set: creates intermediate objects, same as the flat path below. */
function setNestedValue(root: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let target: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!target[parts[i]] || typeof target[parts[i]] !== 'object') {
      target[parts[i]] = {};
    }
    target = target[parts[i]] as Record<string, unknown>;
  }
  target[parts[parts.length - 1]] = value;
}

/** Generic nested-get. Returns `undefined` for any missing intermediate step. */
function getNestedValue(root: Record<string, unknown>, key: string): unknown {
  let target: unknown = root;
  for (const part of key.split('.')) {
    if (target === null || typeof target !== 'object') return undefined;
    target = (target as Record<string, unknown>)[part];
  }
  return target;
}

type LeafValidation = { value: unknown } | { error: string };

/** Validate + coerce a raw CLI string for one `LlmProviderConfig` leaf. */
function validateLlmProviderLeaf(leaf: LlmProviderLeaf, raw: string): LeafValidation {
  switch (leaf) {
    case 'kind':
      if (!(LLM_KIND_VALUES as readonly string[]).includes(raw)) {
        return { error: `must be one of: ${LLM_KIND_VALUES.join(', ')} (got: ${JSON.stringify(raw)})` };
      }
      return { value: raw };
    case 'endpoint': {
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        return { error: `must be a valid URL (got: ${JSON.stringify(raw)})` };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { error: `must be an http:// or https:// URL (got: ${JSON.stringify(raw)})` };
      }
      return { value: raw };
    }
    case 'model':
    case 'apiKey':
    case 'apiKeyEnv':
      if (raw.trim() === '') return { error: 'must be a non-empty string' };
      return { value: raw };
    case 'offMachine':
    case 'disableThinking':
      if (raw !== 'true' && raw !== 'false') {
        return { error: `must be "true" or "false" (got: ${JSON.stringify(raw)})` };
      }
      return { value: raw === 'true' };
    case 'ctxBudget':
    case 'timeoutMs':
      if (!/^\d+$/.test(raw) || parseInt(raw, 10) <= 0) {
        return { error: `must be a positive integer (got: ${JSON.stringify(raw)})` };
      }
      return { value: parseInt(raw, 10) };
  }
  // Unreachable when LLM_PROVIDER_LEAVES stays exhaustive (see the tripwire
  // above) — kept as a throw, not a fall-through return, so a future leaf
  // added to the type but not to this switch fails loudly instead of
  // silently accepting whatever string the user typed.
  throw new Error(`no validator for llm provider leaf: ${leaf as string}`);
}

/**
 * `fallback` must name a currently-registered provider, or the `'skip'`
 * sentinel the router treats as "leave the work pending" (lib/llm/router.ts
 * `fallback()`, and see lib/doctor/llm-providers.ts for the same contract).
 */
function validateLlmFallback(raw: string, config: Config): LeafValidation {
  if (raw.trim() === '') return { error: 'must be a non-empty string' };
  if (raw === 'skip') return { value: raw };
  const providers = config.cortex?.llm?.providers ?? {};
  const known = Object.keys(providers);
  if (!known.includes(raw)) {
    return {
      error: known.length > 0
        ? `must name a registered provider (${known.join(', ')}) or "skip"`
        : 'must name a registered provider or "skip" (no providers are configured yet)',
    };
  }
  return { value: raw };
}

/**
 * Write a validated `cortex.llm.*` value, save it, and print the confirmation
 * (AC1: the resulting provider block, or the top-level `cortex.llm` block for
 * `fallback`) plus the daemon-restart note (AC4).
 */
function writeCortexLlmValue(key: string, parsed: CortexLlmKey, value: unknown, config: Config): void {
  setNestedValue(config as unknown as Record<string, unknown>, key, value);
  saveConfig(config);

  console.log(chalk.green('✓') + ` ${key} = ${JSON.stringify(value)}`);
  const cortex = (config as unknown as Record<string, unknown>).cortex as Record<string, unknown> | undefined ?? {};
  const llm = (cortex.llm as Record<string, unknown> | undefined) ?? {};
  if (parsed.kind === 'fallback') {
    console.log(JSON.stringify(llm, null, 2));
  } else {
    const providers = (llm.providers as Record<string, unknown> | undefined) ?? {};
    console.log(JSON.stringify(providers[parsed.name] ?? {}, null, 2));
  }
  console.log(chalk.dim(
    '  The daemon reads config at start — restart with `think daemon stop && think daemon start`.',
  ));
}

/**
 * Handle `think config set cortex.llm.*`. Separate from the flat path below
 * because the write target is nested and the value needs schema-aware
 * validation (AGT-1327 AC2), not the flat path's best-effort true/false/int
 * coercion.
 */
function handleCortexLlmSet(key: string, rawValue: string): void {
  const parsed = parseCortexLlmKey(key);
  if (!parsed) {
    console.error(chalk.red(`Unknown config key: ${key}`));
    console.error(chalk.dim(`Allowed cortex.llm.* keys: ${describeLlmAcceptedLeaves()}`));
    process.exit(1);
  }

  if (parsed.kind === 'fallback') {
    // Needs the current registry to validate against (is this name
    // registered?), so config must be loaded before validating.
    const config = getConfig();
    const validation = validateLlmFallback(rawValue, config);
    if ('error' in validation) {
      console.error(chalk.red(`Invalid value for ${key}: ${validation.error}`));
      process.exit(1);
    }
    writeCortexLlmValue(key, parsed, validation.value, config);
    return;
  }

  // A provider leaf's validation is self-contained — validate before loading
  // config, so a rejected value never has the side effect of materializing a
  // config file that didn't exist yet (getConfig() creates one on first read,
  // which would otherwise make "nothing written" on failure a lie).
  const validation = validateLlmProviderLeaf(parsed.leaf, rawValue);
  if ('error' in validation) {
    console.error(chalk.red(`Invalid value for ${key}: ${validation.error}`));
    process.exit(1);
  }
  writeCortexLlmValue(key, parsed, validation.value, getConfig());
}

/** Handle `think config get cortex.llm.*`. */
function handleCortexLlmGet(key: string): void {
  const parsed = parseCortexLlmKey(key);
  if (!parsed) {
    console.error(chalk.red(`Unknown config key: ${key}`));
    console.error(chalk.dim(`Allowed cortex.llm.* keys: ${describeLlmAcceptedLeaves()}`));
    process.exit(1);
  }
  const config = getConfig();
  const value = getNestedValue(config as unknown as Record<string, unknown>, key);
  if (value === undefined) {
    console.log(chalk.dim(`${key} is not set`));
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

export const configCommand = new Command('config')
  .description('View or update think configuration');

configCommand.addCommand(new Command('show')
  .description('Print current configuration')
  .action(() => {
    const config = getConfig();
    console.log(JSON.stringify(config, null, 2));
  }));

configCommand.addCommand(new Command('get')
  .argument('<key>', 'Config key (e.g., cortex.author, cortex.llm.providers.<name>.model)')
  .description('Read a configuration value')
  .action((key: string) => {
    if (key.startsWith('cortex.llm.')) {
      handleCortexLlmGet(key);
      return;
    }

    if (!ALLOWED_KEYS.has(key)) {
      console.error(chalk.red(`Unknown config key: ${key}`));
      console.error(chalk.dim(`Allowed keys: ${[...ALLOWED_KEYS].join(', ')}`));
      process.exit(1);
    }

    const config = getConfig();
    const value = getNestedValue(config as unknown as Record<string, unknown>, key);
    if (value === undefined) {
      console.log(chalk.dim(`${key} is not set`));
      return;
    }
    console.log(JSON.stringify(value, null, 2));
  }));

configCommand.addCommand(new Command('set')
  .argument('<key>', 'Config key (e.g., cortex.author, cortex.llm.providers.<name>.model, cortex.llm.fallback)')
  .argument('<value>', 'Value to set')
  .description('Set a configuration value')
  .action((key: string, value: string) => {
    // cortex.llm.* (AGT-1327) is a nested provider registry, not a flat key —
    // routed separately, before the flat ALLOWED_KEYS check, so it never falls
    // through to "Unknown config key" for a leaf that genuinely exists.
    if (key.startsWith('cortex.llm.')) {
      handleCortexLlmSet(key, value);
      return;
    }

    if (!ALLOWED_KEYS.has(key)) {
      console.error(chalk.red(`Unknown config key: ${key}`));
      console.error(chalk.dim(`Allowed keys: ${[...ALLOWED_KEYS].join(', ')}`));
      process.exit(1);
    }

    const allowed = ENUM_KEYS[key];
    if (allowed !== undefined && !allowed.includes(value)) {
      console.error(chalk.red(`Invalid value for ${key}: ${JSON.stringify(value)}`));
      console.error(chalk.dim(`Allowed values: ${allowed.join(', ')}`));
      process.exit(1);
    }

    if (BOOLEAN_KEYS.has(key) && value !== 'true' && value !== 'false') {
      console.error(chalk.red(`Invalid value for ${key}: must be "true" or "false" (got: ${JSON.stringify(value)})`));
      process.exit(1);
    }

    // proxy.url must be ws:// or wss://.
    if (key === 'proxy.url' && value.trim() !== '' && !isValidProxyUrl(value)) {
      console.error(chalk.red(`proxy.url must be a ws:// or wss:// URL (got: ${JSON.stringify(value)})`));
      process.exit(1);
    }

    const config = getConfig();

    // Parse value
    let parsed: unknown = value;
    if (value === 'true') parsed = true;
    else if (value === 'false') parsed = false;
    else if (/^\d+$/.test(value)) parsed = parseInt(value, 10);

    setNestedValue(config as unknown as Record<string, unknown>, key, parsed);
    saveConfig(config);

    console.log(chalk.green('✓') + ` ${key} = ${JSON.stringify(parsed)}`);
    if (RETIRED_KEYS.has(key)) {
      process.stderr.write(`think: ${key} is no longer used — the engram tier was removed in think 3.\n`);
    }
    if (DAEMON_RESTART_KEYS.has(key)) {
      console.log(chalk.dim('  Restart the daemon for this change to take effect (`think daemon restart`).'));
    }
  }));
