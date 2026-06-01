import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { getThinkConfigDir } from './paths.js';

export interface FsBackendConfig {
  /**
   * Absolute path to the cortex root directory. Each cortex lives under
   * `<path>/<cortex>/` and stores per-peer JSONL buckets. Whatever sync
   * tool (iCloud, Drive, Syncthing, or none) governs the folder is opaque
   * to think — see `~/Ideas/think-cli-v2/01-local-fs-adapter.md`.
   */
  path: string;
}

/**
 * Tunable weights and thresholds for the composite retro value signal
 * (AGT-460 / design doc §5 M5). Every field is optional; omitted fields fall
 * back to the `DEFAULT_RETRO_VALUE_SIGNAL_*` constants in
 * `retro-value-signal.ts`. The composite is a weighted sum of deliberate-use
 * signals (independent re-reports, brief/session-start surfacings) plus a
 * recency bonus, with mid-session vector surfacings weighted well below them.
 */
export interface RetroValueSignalConfig {
  /** Weight per independent re-report (`occurrences`). The strongest signal. */
  occurrenceWeight?: number;
  /** Weight per `source='brief'` surfacing (deliberate task-start load). */
  briefWeight?: number;
  /** Weight per session-start surfacing (`session_seq=1`). */
  sessionStartWeight?: number;
  /** Weight per mid-session surfacing (`session_seq>1`) — vector noise. */
  midSessionWeight?: number;
  /**
   * Maximum bonus added when the last high-similarity surfacing is fresh. The
   * bonus decays exponentially with the age (in days) of that surfacing.
   */
  recencyWeight?: number;
  /** Exponential decay constant (per day) for the recency bonus. */
  recencyDecayPerDay?: number;
  /**
   * Score (`retro_surfacings.score`, the recency-weighted cosine) at or above
   * which a surfacing counts as "high-similarity" for the recency bonus.
   */
  highSimilarityThreshold?: number;
  /**
   * Composite-signal value at or above which the curator promotes a retro.
   * Replaces the old raw `occurrences >= 2` gate. The default is tuned so a
   * retro with two independent occurrences still promotes with no telemetry.
   */
  promoteThreshold?: number;
}

export interface CortexConfig {
  /** Git remote URL. Optional — only used by the git sync backend. */
  repo?: string;
  /** Local-fs backend. Mutually exclusive with `repo`. */
  fs?: FsBackendConfig;
  active?: string;
  author: string;
  curateEveryN?: number;
  confirmBeforeCommit?: boolean;
  selectivity?: 'low' | 'medium' | 'high';
  granularity?: 'detailed' | 'summary';
  maxMemoriesPerRun?: number;
  bucketSize?: number;
  onboardingDepth?: number;
  engramTTLDays?: number;
  idleWindowMinutes?: number;
  staleWindowMinutes?: number;
  retroRelegateAfterRuns?: number;
  /**
   * Minimum trimmed-character length for a `kind=retro` write (AGT-455).
   * Retros below this are rejected at intake unless `--force` is set.
   * Default 40 (see `DEFAULT_RETRO_MIN_LENGTH`).
   */
  retroMinLength?: number;
  /**
   * Cosine-similarity threshold above which a new retro is folded into an
   * existing near-duplicate retro (occurrences++) instead of inserted
   * (AGT-455). Default 0.95 (see `DEFAULT_RETRO_NEAR_DUP_THRESHOLD`).
   */
  retroNearDupThreshold?: number;
  /**
   * Weights and thresholds for the composite retro value signal (AGT-460 /
   * design doc §5 M5). The composite replaces raw surface-count as the value
   * proxy in promotion logic and the `think retro-usage` ranking. See
   * `retro-value-signal.ts` for the formula and the per-field defaults.
   */
  retroValueSignal?: RetroValueSignalConfig;
  /**
   * Persistent opt-in to ship cortex content to Anthropic via the Claude
   * Agent SDK (`think curate`, `think long-term backfill`, episode
   * curation, retro dedupe). The CLI fails closed if this is `false`/
   * unset AND `THINK_LLM_CONSENT` env var is also unset (AGT-065).
   */
  llmConsent?: boolean;
  /**
   * Hard ceiling on the assembled curation prompt size in characters.
   * Default 50_000 (~12k tokens). When exceeded, the assembler trims
   * recent-memories oldest-first and prints a warning. AGT-065 INFO #20.
   */
  curatorPromptCharCap?: number;
  /**
   * Which LLM backend think's curation calls should use.
   *
   * - `'auto'` (default) — local-first: route to the local model when one is
   *   configured (`local.endpoint` set) and the task fits its context budget;
   *   fall back to Anthropic only when the task is too big AND LLM consent is
   *   granted. With no `local.endpoint` set, `'auto'` behaves exactly as
   *   pre-local-first think did (Anthropic via the Claude Agent SDK) — so the
   *   feature is inert until a user opts in by configuring an endpoint.
   * - `'local'` — local only. Never ships to Anthropic; if a task overflows the
   *   local context budget the call is skipped with a warning (engrams stay
   *   pending for a later run).
   * - `'anthropic'` — Anthropic only (the legacy path).
   *
   * Env override: `THINK_LLM_PROVIDER`.
   */
  llmProvider?: 'auto' | 'local' | 'anthropic';
  /** Local OpenAI-compatible LLM backend (oMLX/Qwen). See `LocalLlmConfig`. */
  local?: LocalLlmConfig;
  /**
   * Use git plumbing (hash-object / read-tree / commit-tree / update-ref) to
   * append cross-cortex L1 writes directly to the cortex branch ref, instead
   * of checking that branch out into the shared worktree first (#70 Option B,
   * iterative-learning-v2 §6 / AGT-458).
   *
   * The plumbing path never runs `git switch` on the shared worktree, which
   * removes the cross-cortex switch race that was the root of the
   * #70/#65/#69 fragility class. Default `true`. Set to `false` to fall back
   * to the legacy switch+commit worktree path (kept as a reversible escape
   * hatch while the plumbing path soaks).
   */
  plumbingWrites?: boolean;
}

/**
 * Configuration for the local, OpenAI-compatible LLM backend (oMLX/Qwen, the
 * same server hal9k's `localqwen up` drives). think POSTs to
 * `<endpoint>/chat/completions` with a Bearer token. Every field has an env
 * override so CI/agents can point at a different server without editing config.
 */
export interface LocalLlmConfig {
  /**
   * OpenAI-compatible base URL, e.g. `http://localhost:8080/v1`. When unset,
   * local routing is disabled and `llmProvider: 'auto'` falls back to the
   * Anthropic path. Env override: `THINK_LOCAL_ENDPOINT`.
   */
  endpoint?: string;
  /**
   * Model id served at the endpoint (e.g. a Qwen id from `GET <endpoint>/models`).
   * Required when `endpoint` is set. Env override: `THINK_LOCAL_MODEL`.
   */
  model?: string;
  /**
   * Bearer token for the local endpoint. Defaults to `"lm-studio"` (matching
   * hal9k's default for local servers that ignore auth). Env override:
   * `THINK_LOCAL_API_KEY`.
   */
  apiKey?: string;
  /**
   * Token budget used to decide whether a task fits the local model. The router
   * estimates the prompt at ~chars/4 tokens; if the estimate exceeds this
   * budget it routes to Anthropic (auto) or skips (local). Leave headroom below
   * the model's true context window for the response. Default: 28_000.
   * Env override: `THINK_LOCAL_CTX_BUDGET`.
   */
  ctxBudget?: number;
}

export interface SubscriptionsConfig {
  /** Base URL of the `think serve` proxy (no trailing slash). */
  proxyUrl: string;
  /** Bearer token matching the proxy's `THINK_TOKEN`. */
  token: string;
  /**
   * Per-subscription cursor: highest `server_seq` already pulled into the
   * local engram DB. `think subscribe poll` resumes from `cursors[id] + 0`
   * via `?since=<cursor>`. Stored in the same `config.json` (mode 0600);
   * fine for tens of subscriptions, flag a follow-up if a real user racks
   * up hundreds and the file gets noisy.
   */
  cursors?: Record<string, number>;
  /**
   * Per-subscription JSONPath-subset redact selectors (AGT-066). Applied
   * during `think subscribe poll` after the baseline PII strip and before
   * the payload lands as engram content. Selector format is `$.a.b.c.d`
   * or `a.b.c.d` (leading `$.` optional, no array indices/wildcards/
   * filters). See `src/lib/subscribe-redact.ts`.
   */
  redact?: Record<string, string[]>;
}

export interface SearchConfig {
  /**
   * Vector search engine. `"brute-force"` runs cosine over all L2 BLOBs
   * in-process — fast enough for <50K vectors. `"sqlite-vec"` loads the
   * sqlite-vec extension for ANN-style search; falls back to brute-force if
   * the extension cannot be loaded (e.g. unsupported OS / Node build).
   * Default: `"brute-force"`.
   */
  engine?: 'brute-force' | 'sqlite-vec';
}

export interface DaemonConfig {
  /**
   * Windows-only TCP fallback port. On macOS/Linux the daemon binds a Unix
   * domain socket; this field is ignored on those platforms.
   * Default: 47821.
   */
  tcpPort?: number;
}

export interface RecallConfig {
  /**
   * Exponential decay constant for recency-weighted ranking.
   *
   * score = cosine × exp(-recencyDecay × (max_seq - entry_seq))
   *
   * At recencyDecay=0.05:
   *   seq_distance=0  → weight=1.00 (most recent entry, full weight)
   *   seq_distance=14 → weight≈0.50 (~half weight)
   *   seq_distance=28 → weight≈0.25 (~quarter weight)
   *
   * This ensures the most recent ~20 entries always dominate regardless of
   * corpus age or absolute timestamp spread — recency is corpus-relative,
   * not wall-clock-relative.
   *
   * Set to `0` to disable recency weighting and return pure cosine ranking.
   *
   * Default: 0.05
   */
  recencyDecay?: number;

  /**
   * Absolute cosine-similarity floor for recall (AGT-456 / design doc §5 M2).
   *
   * Any candidate whose raw cosine similarity (in [−1, 1], BEFORE recency
   * reweighting) is below this floor is excluded from the result set. This
   * stops sparse cortexes from surfacing garbage-tier matches just because
   * they are the best of a bad top-K — a query with no above-floor matches
   * returns zero entries rather than low-similarity junk.
   *
   * Reuses the compaction-triage 0.6 as a starting point; tune after a sweep
   * against the usage corpus (design doc §8 open question).
   *
   * The floor is inapplicable in the FTS-fallback path (no embeddings, hence
   * no cosine to compare) — FTS results are ranked by the FTS5 engine and
   * carry `similarity: 0`, so the floor is intentionally NOT applied there.
   *
   * Range: [−1, 1]. Set to `-1` (or any value ≤ −1) to disable the floor.
   *
   * Default: 0.6
   */
  relevanceFloor?: number;

  /**
   * Additive quality boost applied to a recall candidate whose retro is
   * curator-promoted (`retros.promoted = 1`), on top of the cosine × recency
   * score (AGT-459 / design doc §5 M4).
   *
   * The boost is intentionally small relative to the cosine spread so curated
   * quality breaks ties and lifts a promoted lesson above an equal-similarity
   * un-promoted one, WITHOUT letting a weak-but-promoted match drown a strong
   * exact match (design doc §8 open question). Memory rows and un-curated
   * cortexes have no matching `retros` row and receive no boost, so ranking is
   * unchanged for them (graceful degradation).
   *
   * Set to `0` to disable the boost.
   *
   * Default: 0.1
   */
  qualityBoost?: number;

  /**
   * Additive quality penalty (subtracted from the score) applied to a recall
   * candidate whose retro was curator-relegated — `retros.promoted = 0` with
   * prior recall history (`recalled_count > 0`), i.e. a retro that was once
   * promoted and later demoted by the relegation pass (AGT-457). This is
   * distinct from a never-curated retro (`promoted = 0`, `recalled_count = 0`),
   * which receives no penalty so un-curated cortexes do not regress.
   *
   * Stored as a non-negative magnitude; it is subtracted from the score.
   *
   * Set to `0` to disable the penalty.
   *
   * Default: 0.1
   */
  qualityPenalty?: number;
}

export interface CompactionConfig {
  /**
   * Master kill-switch for write-time compaction. Set to `false` to disable
   * all compaction LLM calls without revoking general LLM consent. Jobs
   * already in the queue are drained (no-op skips) rather than dropped —
   * consistent with triage-gate skip behaviour. Defaults to `true` when
   * absent.
   *
   * Use case: emergency stop when the LLM produces bad supersession results
   * without disabling retro supersession checks or other LLM features.
   *
   * Default: true
   */
  enabled?: boolean;

  /**
   * Cosine similarity threshold for the compaction triage gate (AGT-300).
   *
   * Before calling the LLM, the worker searches L2 for the top-K most
   * similar entries in the same cortex. If max(candidate.cosine) is below
   * this threshold, the LLM call is skipped — the new entry is net-new on
   * its topic and there is nothing to fold.
   *
   * Range: [−1, 1]. Higher = stricter (more entries skip LLM). The default
   * 0.6 is a rough heuristic; tune after observing your corpus in alpha.
   *
   * Default: 0.6
   */
  triageThreshold?: number;
}

export interface ProxyConfig {
  /**
   * WebSocket URL of the think-v3 proxy server (ws:// or wss:// only).
   * When set, the daemon connects and listens for near-realtime push
   * notifications; on push it fetches immediately instead of waiting for
   * the next poll interval.
   * Set via `think config set proxy.url <url>`.
   * Requires daemon restart for changes to take effect.
   */
  url?: string;
}

export interface Config {
  peerId: string;
  syncPort: number;
  cortex?: CortexConfig;
  paused?: boolean;
  subscriptions?: SubscriptionsConfig;
  search?: SearchConfig;
  daemon?: DaemonConfig;
  recall?: RecallConfig;
  compaction?: CompactionConfig;
  proxy?: ProxyConfig;
}

export function getConfigDir(): string {
  return getThinkConfigDir();
}

function configPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function saveConfig(config: Config): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
}

// Module-local guard so a long-lived process that calls getConfig() many
// times only emits the v2 deprecation banner once. The persisted file is
// rewritten on the first call so subsequent processes never re-warn.
let legacyServerWarned = false;

export function getConfig(): Config {
  const fp = configPath();
  if (fs.existsSync(fp)) {
    const raw = fs.readFileSync(fp, 'utf-8');
    const parsed = JSON.parse(raw) as Config & { cortex?: { server?: { url?: unknown } } };
    if (parsed.cortex && 'server' in parsed.cortex) {
      // Echo the dropped URL (token stays redacted) so a user who upgrades,
      // runs anything, then realizes they wanted to migrate has a trace
      // they can paste into a v1 invocation. Token is intentionally never
      // surfaced — it lands in stderr/cron logs/scrollback otherwise.
      const droppedUrl = typeof parsed.cortex.server?.url === 'string' ? parsed.cortex.server.url : null;
      // Side-channel backup before the destructive prune. Most users don't
      // back up ~/.think/config.json; if they miss the one-shot stderr
      // banner (cron, piped output, scrollback), the URL/token are gone.
      // Same dir, same perms (0o600 enforced via fs.writeFileSync mode).
      const backupPath = `${fp}.pre-v2-prune`;
      let backupOk = false;
      try {
        fs.writeFileSync(backupPath, raw, { mode: 0o600 });
        backupOk = true;
      } catch {
        // Backup failure is non-fatal but load-bearing for recovery — the
        // banner copy below branches on backupOk so the user is never
        // told a backup exists when it doesn't.
      }
      delete parsed.cortex.server;
      if (!legacyServerWarned) {
        legacyServerWarned = true;
        const urlLine = droppedUrl
          ? `       URL was: ${droppedUrl}  (token redacted)\n`
          : '';
        // Backup status is load-bearing: a user who reads "backup written"
        // and then deletes their notes assuming they have a fallback has
        // lost data. Fail loud when the backup didn't take.
        const backupLine = backupOk
          ? `       A backup of the pre-prune config was written to ${backupPath} (mode 0600).\n`
          : `       WARNING: failed to write a backup to ${backupPath}.\n` +
            `       The URL echoed above is your only record of the dropped server config.\n`;
        process.stderr.write(
          `think: dropped legacy \`cortex.server\` from ${fp} — the http backend retired in v2.\n` +
          urlLine +
          backupLine +
          '       If you have data on the v1 http backend, downgrade to think-cli v1 and run\n' +
          '         `think cortex migrate --to fs --path <path>`\n' +
          '       FIRST to preserve it. Then upgrade and run `think cortex setup --fs <path>`.\n' +
          '       If you have no data to preserve, run `think cortex setup --fs <path>` directly.\n',
        );
      }
      saveConfig(parsed);
    }
    return parsed;
  }

  const config: Config = {
    peerId: uuidv4(),
    syncPort: 47821,
  };
  saveConfig(config);
  return config;
}

/**
 * Returns this peer's stable UUID. Self-heals legacy configs that pre-date
 * the auto-generated `peerId` field by minting one and persisting it back —
 * users on an older install don't need to delete their config to upgrade.
 */
export function getPeerId(): string {
  const config = getConfig();
  if (typeof config.peerId === 'string' && config.peerId.length > 0) {
    return config.peerId;
  }
  config.peerId = uuidv4();
  saveConfig(config);
  return config.peerId;
}
