/**
 * Anthropic API key resolution for think's own raw SDK calls.
 *
 * Isolated here so daemon modules (compaction, supersession) can import just
 * this utility without pulling in the full curator.ts dependency tree.
 */

/**
 * Resolve the API key think should use for its own raw Anthropic SDK calls.
 *
 * Resolution order:
 * 1. `THINK_ANTHROPIC_KEY` — the think-namespaced key. Preferred. Using this
 *    keeps think's billing isolated from other Anthropic SDK tools in the same
 *    shell (e.g. Claude Code), which read `ANTHROPIC_API_KEY` and would
 *    silently switch from subscription to API billing if that var is exported
 *    just to satisfy think's key requirement.
 * 2. `ANTHROPIC_API_KEY` — legacy fallback. Accepted for backward compatibility
 *    with existing deployments (e.g. hivedb `setup.sh` exports this var).
 *    **Deprecated**: prefer `THINK_ANTHROPIC_KEY` for new setups. When only
 *    `ANTHROPIC_API_KEY` is present a one-time warning is emitted to stderr so
 *    operators know to migrate. The warning is stderr-only — never stdout —
 *    because the daemon/proxy paths may have stdout consumers.
 *
 * @internal Use this helper everywhere think constructs an `Anthropic` client
 * so there is exactly one resolution site and the deprecation warning fires
 * at most once per process.
 */
let _deprecationWarningEmitted = false;

/** Reset the deprecation-warning guard. **For use in tests only.** @internal */
export function _resetDeprecationWarningForTests(): void {
  _deprecationWarningEmitted = false;
}

export function resolveThinkApiKey(): string {
  const thinkKey = process.env.THINK_ANTHROPIC_KEY;
  if (thinkKey) return thinkKey;

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    if (!_deprecationWarningEmitted) {
      _deprecationWarningEmitted = true;
      process.stderr.write(
        '[think] Warning: ANTHROPIC_API_KEY is set but THINK_ANTHROPIC_KEY is not. ' +
        'Using ANTHROPIC_API_KEY as a fallback — this is deprecated and will stop ' +
        'working in a future release. Set THINK_ANTHROPIC_KEY instead to isolate ' +
        "think's billing from other Anthropic SDK tools in the same shell " +
        '(e.g. Claude Code).\n',
      );
    }
    return anthropicKey;
  }

  throw new Error(
    'No Anthropic API key found for think. Set THINK_ANTHROPIC_KEY (preferred) ' +
    'or ANTHROPIC_API_KEY (deprecated fallback). See README for details.',
  );
}
