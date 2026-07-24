/**
 * Structural evidence gate for LLM-proposed supersession (issue #87).
 *
 * Compaction and retro supersession retrieve their candidate sets by embedding
 * similarity, then let an LLM decide which candidates the new entry
 * supersedes. Embedding proximity measures shared VOCABULARY, not shared
 * SUBJECT — two entries about "agent memory" that concern entirely different
 * repositories can rank adjacent. When the LLM mislinks such a pair, the
 * superseded entry silently vanishes from active recall while the replacement
 * carries none of its content: unbounded, undetectable data hiding.
 *
 * This module is the code-level guard: a proposed supersession is accepted
 * only when the two entries share STRUCTURAL evidence of being about the same
 * thing —
 *
 *   - a common topic tag (case-insensitive), or
 *   - a common named entity in the content: a repo slug or path segment
 *     (`owner/name`), a ticket id (`ANGL-2041`), an issue/PR ref (`#49`), a
 *     dotted filename (`setup.sh`), or a hyphenated identifier (`ui-quiver`).
 *
 * Shared vocabulary alone never qualifies. When in doubt the gate rejects —
 * a wrongly-kept entry costs a little noise; a wrongly-hidden entry costs a
 * team its record.
 */

/** Trivial dotted tokens that must not count as filename evidence. */
const ENTITY_STOPWORDS = new Set(['e.g', 'i.e', 'etc', 'vs', 'v.s', 'a.k.a', 'node.js']);

/**
 * Extract named-entity tokens from entry content, lowercased.
 *
 * Deliberately structural: every pattern requires punctuation shape
 * (slash, dash-with-digits, leading `#`, dot-extension, internal hyphen)
 * that plain prose vocabulary does not have.
 */
export function extractEntities(content: string): Set<string> {
  const entities = new Set<string>();
  const add = (raw: string): void => {
    const token = raw.toLowerCase().replace(/^[^\w#]+|[^\w]+$/g, '');
    if (token.length >= 3 && !ENTITY_STOPWORDS.has(token)) entities.add(token);
  };

  // Repo slugs and paths (`owner/name`, `cortex/engineering`, `src/lib/x.ts`).
  // Each full slug AND each of its segments count: "Anglepoint-Inc/hivedb" must
  // match an entry that later refers to the project as just "hivedb".
  for (const m of content.match(/[\w.-]+(?:\/[\w.-]+)+/g) ?? []) {
    add(m);
    for (const segment of m.split('/')) add(segment);
  }

  // Ticket ids (ANGL-2041, AGT-455).
  for (const m of content.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g) ?? []) add(m);

  // Issue / PR refs (#49). Kept with the leading # so "#49" only matches "#49".
  for (const m of content.match(/#\d+\b/g) ?? []) add(m);

  // Dotted filenames (setup.sh, apply.ts). Alphabetic extension only, so
  // version numbers (2.4.0) never qualify.
  for (const m of content.match(/\b[\w-]+\.[a-z]{1,8}\b/g) ?? []) add(m);

  // Hyphenated identifiers (ui-quiver, telex-agentd, recall-cli-not-mcp).
  for (const m of content.match(/\b[a-zA-Z][\w]*(?:-[\w]+)+\b/g) ?? []) add(m);

  return entities;
}

export interface SupersedeParty {
  content: string;
  topics: string[];
}

/**
 * True when superseding `b` with `a` is structurally defensible.
 *
 * - Accepts on a shared topic tag or a shared named entity.
 * - Accepts when either side carries NO structural signal at all (no topics,
 *   no extractable entities) — a plain-prose retro like "use pnpm" superseding
 *   "use npm" has nothing to compare, so the decision stays with the LLM as
 *   before.
 * - Rejects when both sides carry structure and none of it overlaps: two
 *   entries that each name their own repos/tickets/files/topics, none in
 *   common, are about different subjects no matter how close their embeddings
 *   sit (the issue #87 mislink class).
 */
export function hasSupersessionEvidence(a: SupersedeParty, b: SupersedeParty): boolean {
  const aTopics = new Set(a.topics.map((t) => t.toLowerCase()));
  for (const topic of b.topics) {
    if (aTopics.has(topic.toLowerCase())) return true;
  }

  const aEntities = extractEntities(a.content);
  const bEntities = extractEntities(b.content);
  for (const entity of bEntities) {
    if (aEntities.has(entity)) return true;
  }

  const aHasStructure = a.topics.length > 0 || aEntities.size > 0;
  const bHasStructure = b.topics.length > 0 || bEntities.size > 0;
  return !aHasStructure || !bHasStructure;
}

export interface SupersedeGateResult {
  accepted: string[];
  rejected: { id: string; reason: string }[];
}

/**
 * Filter LLM-proposed supersedes ids down to the ones with structural
 * evidence, plus an optional pairwise-similarity backstop.
 *
 * @param newEntry       The entry doing the superseding.
 * @param proposedIds    LLM-proposed supersedes ids (already filtered to the
 *                       candidate set by the caller's prompt-injection guard).
 * @param lookup         Resolve an id to its content/topics (and, when the
 *                       caller has it, the candidate's cosine similarity to
 *                       the new entry). Return undefined to reject the id.
 * @param minPairCosine  Reject when the candidate's similarity to the new
 *                       entry is known and below this floor. Pass -Infinity
 *                       to disable.
 */
export function gateSupersedes(
  newEntry: SupersedeParty,
  proposedIds: string[],
  lookup: (id: string) => (SupersedeParty & { similarity?: number }) | undefined,
  minPairCosine: number = -Infinity,
): SupersedeGateResult {
  const accepted: string[] = [];
  const rejected: { id: string; reason: string }[] = [];

  for (const id of proposedIds) {
    const target = lookup(id);
    if (!target) {
      rejected.push({ id, reason: 'target not found' });
      continue;
    }
    if (target.similarity !== undefined && target.similarity < minPairCosine) {
      rejected.push({
        id,
        reason: `pair similarity ${target.similarity.toFixed(3)} below floor ${minPairCosine}`,
      });
      continue;
    }
    if (!hasSupersessionEvidence(newEntry, target)) {
      rejected.push({ id, reason: 'structural signals disjoint (no shared topic or named entity)' });
      continue;
    }
    accepted.push(id);
  }

  return { accepted, rejected };
}
