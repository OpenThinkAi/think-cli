# Iterative Learning v3 — Retro Locality (reverses v2 §6)

Status: **implemented** (2026-06-02, branch `feat/retro-locality-v3`).
Supersedes `iterative-learning-v2.md` §6. Scope: where retros live and how they
are scoped at recall. The v2 quality mechanisms (M1–M5) are unaffected — they
are orthogonal to locality.

## 0. Implementation status (what shipped)

All seven tickets landed on `feat/retro-locality-v3`; full suite green (1351
tests). Notable deltas from the original plan, each detailed in-line below:

- **T1** was nearly a no-op — topic filtering through recall already shipped
  (AGT-320); the "stubbed" premise was two stale comments. Added
  `lib/working-context.ts` (`detectWorkingContext`/`contextTopic`/
  `contextFromTopics`) and fixed the comments.
- **`--cortex`/`-C` = storage only** (no runtime `--cortex`→`--context` alias):
  commander routes the long name to the program-global option in every
  position, so the alias is infeasible. `--context` is the sole context
  override. See §3.2.
- **T5 migration** is a daemon RPC (`retro_migrate`), not a CLI-side mutation —
  the synced-tombstone path (`enqueueL1Outbox` + `pushDebouncer.notify`) lives
  in the daemon. The copy uses `handleSync(..., force: true)` so the M1 write
  gate never drops short-but-real legacy retros. **Forward-only**: once a
  tombstone is pushed it is synced, so `--undo` is NOT implemented — dry-run is
  the safety mechanism. AGT-461's `retro-cleanup` (cited as the reuse pattern)
  turned out **not to be on main**, so the tombstone primitives were used
  directly.
- **T6** removed the curation loop's exclusion of the active cortex — retros now
  live there, and curation is retro-scoped so including it is safe. Context-
  aware *merge* scoping is noted as a follow-up.

## 1. The reversal

v2 §6 chose **Option B** (keep retros on per-context `cortex/<name>` branches;
make cross-cortex writes cheap via git plumbing — shipped as AGT-458) and
explicitly **deferred Option A** (move retros into the active cortex, tagged by
repo). This doc adopts **Option A** and retires the per-context branch model for
retros.

Why the reversal:
- A cortex branch is meant to be a **team / dataset the user lives on** — an
  identity, not a routing key. Retros abused it as a per-repo bucket, which
  forced the daemon to switch branches to land a write. That switching is the
  root of a recurring bug class (#65, #69, the shared-worktree races).
- Retros are **team-specific knowledge**, not universal truth. v2 tried to avoid
  two teams holding different lessons for the same repo; that was the wrong
  goal. Different home cortices *should* hold different retros for the same
  context. This is now a feature, not a conflict to suppress.

## 2. The two-axis model

Today's design conflates two independent things into one (`--cortex`). Split
them:

| Axis | Meaning | Source |
|------|---------|--------|
| **Storage cortex** | the user's home / team — *where the row lives* | active cortex (`config.cortex.active`), respects global `-C` |
| **Context tag** | what the retro is *about* | `basename(git rev-parse --show-toplevel)` of cwd |

A retro is a `kind=retro` row on the **storage cortex**, carrying a **context
tag**. The daemon never switches branches to write one.

Example: `think retro "tests run after merge, before push — don't push without
running checks"` executed in the `stamp-cli` checkout, with active cortex
`engineering`, stores one row on `engineering` tagged context `stamp-cli`. At
home the same command on active cortex `personal` stores it on `personal` —
different team, different corpus, same context. Both correct.

## 3. Design

### 3.1 Tag mechanism — reuse `topics_json`, reserved `repo:` prefix

The `topics_json` column already exists on the cortex DBs and the recall path is
half-wired for it (it just emits `'[]' as topics` and the topic filter throws —
`daemon/recall.ts:233`). Rather than add a first-class `context` column (new
migration, new wire field, new SELECT plumbing), store the context as a
**reserved-prefix topic**: `repo:<context>` (e.g. `repo:stamp-cli`).

- brief/recall pick the context out deterministically by the `repo:` prefix, so
  it never collides with user-supplied free topics (`--topic ux`).
- If context ever needs to become structurally distinct, it can be promoted to a
  column later; nothing here precludes that.

### 3.2 Write path — `think retro` auto-detects context

`commands/retro.ts`:
- **Drop** the `--cortex is required` gate.
- Storage cortex = active cortex (honor global `-C`). No branch switch.
- Context = `basename(git toplevel of cwd)` via a new `lib/working-context.ts`
  helper (`git rev-parse --show-toplevel` from `process.cwd()`), normalized
  lowercase. Stored as topic `repo:<context>`.
- `--context <name>` overrides the auto-detected value (writing a `stamp-cli`
  lesson from elsewhere).
- **`--cortex`/`-C` = storage only.** *Implementation deviation from the
  original alias plan:* commander routes the `--cortex` long name to the
  program-global option in every position, so a command-local `--cortex` is
  never populated and a post-subcommand `--cortex` is indistinguishable from a
  global `-C` (verified empirically). A runtime "treat `--cortex` as
  `--context`" alias is therefore infeasible without dropping the global `-C`.
  So `--cortex`/`-C` selects the home/storage cortex (consistent with every
  other command); `--context` is the sole context override. The transition is
  handled by `retro-migrate` (T5) + template updates (T7), not a runtime alias.
  Old `--cortex <repo>` invocations keep working — they just store on a cortex
  named `<repo>` until templates switch to `--context`.
- **No-repo fallback:** cwd not in a git repo → store untagged with a dim note;
  never hard-error. The pit of success is a bare `think retro "<note>"`.

The common-case surface becomes zero-flag: `think retro "<note>"`.

### 3.3 Recall — tags already flow; brief scopes, recall boosts

**Correction (2026-06-02, verified against `main` @ 2a64257):** the "topic
filtering is stubbed" premise was wrong — it came from two *stale comments*
(`recall.ts` `ColumnInfo.hasTopics` doc, and the `sync-handler.ts` header
claiming kind/topics are "L1 only"). The live code already wires it end-to-end:
the L2 retro insert writes `kind` + `topics_json` (`sync-handler.ts:390–421`),
and recall both filters (`json_each(topics_json)`) and projects
(`topics_json as topics`) on it (`recall.ts:844–861`, AGT-320). So
`think recall --topic repo:stamp-cli` works *today*. The stale comments get
fixed; no net-new recall plumbing is needed for the filter itself.

- **`think brief`** (task-start, run inside a repo): **context-first.**
  Auto-detect context, and the retro section *is* the active cortex's retros
  tagged `repo:<context>`. No context detected → fall back to all retros.
- **`think recall`** (mid-task semantic query): context is a **boost, not a hard
  filter.** Retros tagged with the current context get an additive ranking bump,
  composed with the existing M4 quality boost; lessons from adjacent contexts
  can still surface when genuinely relevant. Hard-filtering everywhere would
  rebuild the rigidity we are removing.

### 3.4 Migration — `think retro-migrate` (Option A data move)

Done as **ordinary synced writes**, not a server-authoritative prune. The sync
model is peer-to-peer append-only JSONL with a union-merge driver; the
`think serve` proxy is a relay, not a source of truth. So:

- For each retro in a source cortex: **append a tagged copy** (`repo:<source>`)
  to the target cortex, and **tombstone the original** via the synced path
  (`deleted_at` on the L2 memories row + an L1 tombstone line to the outbox +
  `pushDebouncer.notify`, mirroring the supersession worker; plus
  `tombstoned_at`/`tombstone_reason` on the curator `retros` row). The copy goes
  through `handleSync(..., force: true)` so the M1 write gate never drops a
  short-but-real legacy retro. The tombstone is **not cleanly reversible once
  pushed** (see §3.4 surface).
- The migration **self-propagates**: appends + union-merge carry it to every
  peer and the proxy. No branch nuking, no divergence, no special remote mode.
- **Idempotent** via a `migrated:<source>` topic marker on each copied row
  (combined with content match); re-runs skip already-migrated rows, and the M1
  near-duplicate fold is a second backstop. This is what makes "every user runs
  it once, safe to re-run, safe if the remote already has it" hold *without* a
  `--remote-db` reconciler.

Surface (dry-run by default):
```
think retro-migrate --to <target> [--from <a,b,c>]   # DRY-RUN by default
think retro-migrate --to engineering --from stamp-cli,think-cli --apply
```
- `--to` = target storage cortex (`personal` at home, `engineering` at work);
  defaults to `-C` / the active cortex.
- `--from` default = every other local cortex (the daemon reports per-source
  counts; empties show 0).
- **Forward-only — no `--undo`.** Once a source tombstone is pushed it is synced
  to all peers, and the append-only L1 model has no clean "un-tombstone" line, so
  reversal is not a safe operation. The **dry-run is the safety valve**: preview
  the per-source counts before `--apply`. (The implementation as shipped does not
  expose `--undo`.)

**Distributed gotcha (non-blocking):** two teammates migrating into the *same*
shared target before syncing could briefly produce two tagged copies of one
source retro. The M1 near-duplicate fold (≥0.95 → `occurrences++`, AGT-455) and
the `migrated_from` marker both reconcile this at next curation. Moot for
personal cortices.

## 4. Downstream machinery

- **Daemon curation (AGT-462, `curation-loop.ts`):** today it curates every
  local repo-cortex branch via `listLocalBranches()`. Retarget it to curate the
  home cortex's retros **grouped by `repo:` context tag**, so curation stays
  context-scoped without per-context branches.
- **AGT-458 cross-cortex plumbing-writes:** keep them — v2 notes they also serve
  sync + compaction — but stop routing *retro writes* through them (retro writes
  are now same-cortex). The migration is the one remaining cross-cortex retro
  writer, and only runs once.
- **Per-context `cortex/<name>` branches** that existed *only* as retro buckets
  can be retired after migration. Team / dataset cortices stay untouched.
- **Templates & guidance:** `think init` retro/brief blocks and the CLAUDE.md
  examples drop `--cortex <repo>` (auto-detected now). `iterative-learning-v2.md`
  §6 gets a pointer to this doc.

## 5. Open questions
- Recall context-boost weight: how large, relative to the M4 quality boost, so
  context-relevance helps without drowning a strong cross-context exact match?
  Needs a sweep against the usage corpus.
- `--from` default safety: auto-selecting "all non-target cortices with retros"
  is convenient but could sweep in a cortex the user considers a real team
  dataset, not a retro bucket. Dry-run + explicit confirm mitigates; consider an
  opt-in `--all` instead of defaulting.
- Context normalization: lowercase basename is the v1 rule. A future
  `.think-context` per-repo override is out of scope (YAGNI) but noted.

## 6. Ticket breakdown (for `refine`)

Dependency-ordered. T1 is foundational.

1. **T1 — Tag plumbing (mostly already done).** Topic filter + `topics_json`
   projection already ship (AGT-320; `sync-handler.ts:390`, `recall.ts:844`).
   Reduces to: fix the two stale comments, and add a shared
   `lib/working-context.ts` (git-root → `repo:<ctx>` helpers:
   `detectWorkingContext`, `contextTopic`, `contextFromTopics`). Tests for the
   helper. No recall-filter plumbing needed.
2. **T2 — Auto-detect context on write.** `commands/retro.ts` +
   `lib/working-context.ts`: drop `--cortex` requirement; storage = active
   cortex; context = git-root basename → `repo:<ctx>` topic; `--context`
   override; deprecate `--cortex`→`--context` (warn); no-repo untagged fallback.
   Tests: detection, override, fallback, deprecation alias.
3. **T3 — brief context-first.** `commands/brief.ts`: auto-detect context, scope
   retro section to `repo:<context>`, fall back to all-retros when none.
   Depends on T1. Tests.
4. **T4 — recall context-boost.** `daemon/recall.ts`: additive boost for retros
   tagged with the active context, composed with M4 quality boost (not a hard
   filter). Depends on T1. Tests.
5. **T5 — `think retro-migrate` command.** New guarded command mirroring
   `retro-cleanup`: `--to`/`--from`, dry-run default, `--apply`, `--undo`;
   tagged-append + reversible-tombstone + `migrated_from` idempotency marker.
   Depends on T2's tag convention. Tests: dry-run, apply, idempotent re-run,
   undo.
6. **T6 — Retarget downstream + retire branches.** Curation loop groups by
   `repo:` context within the home cortex; stop routing retro writes through the
   AGT-458 path; document retiring retro-only `cortex/<name>` branches
   post-migration. Depends on T5. Tests: curation grouping.
7. **T7 — Templates & docs.** Update `think init` retro/brief blocks, CLAUDE.md
   examples, and `iterative-learning-v2.md` §6 pointer. Depends on T2/T3.
