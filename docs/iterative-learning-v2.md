# Iterative Learning v2 — design

Status: **proposal / parked-rethink resolution.** Supersedes the open question
"is the retro paradigm the wrong model?" with a data-driven answer. Folds in
issue #70 (retro locality). No data migration or paradigm removal is in scope
until the parts marked **(gated)** below are approved.

## 1. Context

`think retro` lets agents self-report a free-text lesson about a repo; `think
recall` / `think brief` serve those lessons back via semantic search. On
2026-05-23 the whole paradigm was put under reconsideration ("the corpus is
LLM vomit; self-report → semantic recall may be the wrong model") with a
standing hold: **do not restructure or migrate retro data until a replacement
design exists.** This doc is that replacement design.

It is grounded in the `think retro-usage` telemetry (shipped 1.9.0), which the
parked decision named as the instrument that should drive the rethink.

## 2. Evidence (telemetry snapshot, 2026-06-01)

156 retros across 6 repo cortexes (think-cli, stamp-cli, open-team, dispatch,
ui-leaf, openthink-web). 1,721 lifetime surfacing events.

- **Retrieval works.** 129/156 (83%) have surfaced in recall; median surface
  count **9**; broadly distributed (top-5 retros = only 19% of surfacings — no
  Pareto collapse). The "nobody recalls them" fear is not what the data shows.
- **The corpus is polluted at the source.** 12 retros are pure test/dev
  detritus — `"trigger A"`, `"rapid 1".."rapid 4"`, `"repro stamp-cli"`,
  `"capture full err"`, `"test reproduction attempt 1"`.
- **Junk is actively surfaced.** `"repro attempt cortex think-cli"` surfaced
  **13×**; `"repro stamp-cli"` **12×**. Garbage is being pulled into recall
  context repeatedly.
- **Surface-count is a weak value proxy.** Junk surfaces a lot; genuinely good
  but niche lessons (open-team billing split, stamp-cli release runbooks,
  AGT wire-format contracts) sit in the 27 "dead" never-recalled set simply
  because no query has matched them yet.

**Conclusion that updates the prior hypothesis:** the failure mode is **quality
control**, not the paradigm. Self-report + semantic recall retrieves; it just
admits anything and ranks blind. The fix is to gate intake, close the
feedback loop, and make ranking quality-aware — not to replace the model.

## 3. Diagnosis — where the current system leaks

The machinery is ~80% built; the gaps are open loops, not missing parts.

| Gap | Today | File |
| --- | --- | --- |
| No write-time quality gate | Only a 64 KB size cap; `"trigger A"` is accepted | `daemon/sync-handler.ts` |
| Ranking is quality-blind | `score = cosine × exp(-decay·Δseq)`; `promoted` is ignored | `daemon/recall.ts` |
| No relevance floor | Recall returns top-K even when the best match is garbage-tier (sparse cortexes always surface junk) | `daemon/recall.ts` |
| Feedback loop is open | `retro_surfacings` telemetry is never written back to `retros.last_recalled_at` | `db/usage-db.ts` ↔ `retros` table |
| Relegation is dormant | `curate-retros.ts` relegate path exists but is inactive pending `last_recalled_at` wiring; curator is manual-only | `commands/curate-retros.ts` |
| Locality (#70) | Every retro is a cross-cortex write that forces a shared-worktree `git switch` | `lib/git.ts`, `daemon/push-debouncer.ts` |

## 4. Goals / non-goals

**Goals**
- Keep self-report as the primary channel (evidence says it works).
- Stop junk entering the corpus, and stop junk surfacing in recall.
- Close the surfacing → curation feedback loop so dormant relegation activates.
- Make recall quality-aware so good lessons outrank noise.
- Resolve #70's locality without a data migration.

**Non-goals (this round)**
- Replacing self-report with outcome-derived learning (PR comments, failed
  commands, incidents). Noted as a *complementary future channel* (§9), not a
  replacement — the data doesn't justify ripping out what works.
- Moving retros off per-repo branches into the active cortex (#70 Option A).
  See §6.

## 5. Design

Six mechanisms, each building on existing infra.

### M1 — Write-time quality gate (intake)
Reject obvious non-lessons at `sync-handler.ts` before they're stored:
- Minimum signal: reject content below a length floor (e.g. < 40 chars) unless
  `--force`.
- Test-shape heuristic: reject content matching a junk pattern set
  (`^(repro|rapid|trigger|test)\b`, single-token, etc.).
- Near-duplicate guard: if an embedding ≥ 0.95 to an existing retro in the same
  cortex exists, fold into `occurrences++` instead of inserting a new row
  (cheap dedup before the LLM supersession worker even runs).
Surfaces an actionable rejection to the user (the un-truncated error path from
1.11.1 already supports this).

### M2 — Relevance floor (surfacing)
Add an absolute-similarity floor to recall: do not surface a retro whose cosine
is below a threshold (reuse the compaction triage's 0.6 as a starting point,
config-tunable). This alone kills most sparse-cortex junk surfacing — a retro
no longer rides into context just because it's the best of a bad top-K.

### M3 — Close the feedback loop
Wire `retro_surfacings` → `retros.last_recalled_at` / `recalled_count`. This is
the single missing link that activates the already-written relegation path.
Either the daemon updates it on each surfacing, or `curate-retros` reconciles
it from usage.db on each run.

### M4 — Quality-aware ranking
Fold curator state into the recall score: a small boost for `promoted=1`, a
penalty (or exclusion) for relegated retros, so curated quality — not raw
vector luck — drives ordering. Keep it additive to `cosine × recency` so the
behaviour degrades gracefully when curator state is absent.

### M5 — A better value signal than surface-count
Surface-count conflates "vector-similar to many queries" with "useful." Replace
it (in promotion logic and the usage view's ranking) with a composite:
- `occurrences` (independently re-reported = a recurring real lesson),
- `brief`-source / session-start surfacings (deliberate task-start loads)
  weighted above mid-session vector noise (telemetry already records `source`
  and `session_seq`),
- recency of last *high-similarity* surfacing.

### M6 — Automate curation
Run `curate-retros` (merge + promote + relegate) from the daemon on a cadence,
not just by hand, so the corpus self-maintains. Keep `--dry-run` and the
manual entry point.

## 6. Issue #70 — locality decision

Two options were on the table:
- **Option A** (retros → `kind=retro` rows in the active cortex, tagged by
  repo): a data-model migration. **Deferred** — it is exactly the restructuring
  the standing hold forbids, and §5 makes it unnecessary: M1–M5 fix the quality
  problem without moving data, and the worktree cost is addressed by B.
- **Option B** (daemon writes cross-cortex via git plumbing —
  `hash-object`/`mktree`/`commit-tree`/`update-ref` — instead of
  `switch`+commit): **adopt.** It is paradigm-agnostic, touches no retro data,
  removes the shared-worktree switch entirely (also moots #65 and the #69
  failure class), and benefits sync + compaction, not just retros. Larger code
  change to the `lib/git.ts` / `push-debouncer.ts` seams; sequence it after the
  quality mechanisms since #69's self-heal already contains the acute bug.

## 7. Migration & the hold **(gated)**

The standing hold blocks data changes until this design is approved. On
approval, lift it for a **staged, reversible** cleanup only:
1. Purge the 12 identified junk retros (test-shaped, zero real signal). These
   are not lessons; deleting them is not "clearing the learnings corpus."
2. Backfill `last_recalled_at` from usage.db (M3) so relegation has history.
3. Leave all substantive retros — including the 15 good-but-niche "dead" ones —
   untouched; M2+M4 stop them being noise without deleting them.

No cortex-branch nuking, no tombstoning of real lessons.

## 8. Open questions
- Relevance-floor threshold: is 0.6 right for recall, or does it over-filter
  legitimate lateral matches? Needs a sweep against the usage corpus.
- Does M4's quality boost belong in the score, or as a re-rank after a
  similarity-only top-N? (Avoids quality drowning a strong exact match.)
- Should the write-time gate be a hard reject or a "low-signal, stored but
  de-prioritised" soft tier?

## 9. Future channel (out of scope)
Outcome-derived learning — mining failed commands, PR-review comments, and
incident threads instead of relying on self-report — remains the most promising
*complementary* source. It is additive to, not a replacement for, the gated
self-report channel designed here. Track separately.

## 10. Proposed ticket breakdown (for `refine`)
1. M1 write-time quality gate (sync-handler) + tests.
2. M2 recall relevance floor (config-tunable) + tests.
3. M3 wire `retro_surfacings` → `retros.last_recalled_at`; activate relegation.
4. M4 quality-aware recall ranking.
5. M5 composite value signal (promotion logic + `retro-usage` view).
6. M6 daemon-scheduled curation.
7. #70 Option B — plumbing-based cross-cortex writes (depends on none; large).
8. (gated) staged junk purge + `last_recalled_at` backfill.
