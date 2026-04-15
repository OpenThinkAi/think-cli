import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getCuratorMdPath, getLongtermPath, ensureThinkDirs } from './paths.js';
import type { Engram } from '../db/engram-queries.js';

export interface MemoryEntry {
  ts: string;
  author: string;
  content: string;
  source_ids: string[];
}

const BASE_CURATION_PROMPT = `You are a memory curator. You evaluate recent work events and decide which ones are significant enough to become shared team memory.

## Long-term context (compressed history)
{longterm_summary}

## Recent team memories (last 2 weeks)
{recent_memories}

## What this contributor considers worth sharing
{curator_md}

## Recent work events to evaluate
{pending_engrams}

---

Your task:

1. Read the long-term context and recent memories to avoid redundancy.
2. Read the contributor's guidance (if provided) for their priorities.
3. For each event, decide: is this something the team should remember?
   Look for:
   - Completed work, shipped deliverables, merged code
   - Decisions made, direction changes, pivots
   - Blockers encountered or resolved
   - Clusters — multiple events around the same topic signal importance
   - Weight — urgency, frustration, or surprise in the language suggests significance
4. Routine, administrative, or low-signal events should be dropped.
   Dropping is correct, not a failure.

Output format — return a JSON array of entries to append:
[
  {
    "ts": "ISO 8601 timestamp",
    "author": "contributor name",
    "content": "the memory — specific, factual, written for an agent",
    "source_ids": ["id1", "id2"]
  }
]

If nothing warrants a new entry, return an empty array: []

Rules:
- Write for an agent that will read this as context before starting work
- Be specific: names, projects, decisions, status — not generalizations
- Each entry should be 1-3 sentences
- Do not reference this process or explain your reasoning
- Do not include PII, HR matters, compensation, or client-confidential details
- Do not repeat information already in the team's memory
- Only add an entry if there is genuinely new information`;

const CONSOLIDATION_PROMPT = `You are a memory consolidator. You compress older detailed memories into a concise long-term summary.

## Existing long-term summary
{existing_longterm}

## Memories to consolidate (these are aging out of the short-term window)
{aging_memories}

---

Your task:

Produce an updated long-term summary that incorporates the aging memories into the existing summary. The summary should:

- Capture key projects, decisions, and milestones — not individual commits
- Preserve what's still relevant from the existing summary
- Group related work into coherent themes
- Be concise — aim for 500-1000 words total
- Write for an agent that needs historical context, not a detailed log

Return only the updated summary text. No JSON, no formatting, no explanation.`;

export function readCuratorMd(): string | null {
  const mdPath = getCuratorMdPath();
  if (fs.existsSync(mdPath)) {
    return fs.readFileSync(mdPath, 'utf-8').trim();
  }
  return null;
}

export function readLongtermSummary(cortexName: string): string | null {
  const ltPath = getLongtermPath(cortexName);
  if (fs.existsSync(ltPath)) {
    return fs.readFileSync(ltPath, 'utf-8').trim();
  }
  return null;
}

export function writeLongtermSummary(cortexName: string, summary: string): void {
  ensureThinkDirs();
  const ltPath = getLongtermPath(cortexName);
  fs.writeFileSync(ltPath, summary, 'utf-8');
}

export function filterRecentMemories(memories: MemoryEntry[], windowDays: number = 14): {
  recent: MemoryEntry[];
  older: MemoryEntry[];
} {
  const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString();
  const recent: MemoryEntry[] = [];
  const older: MemoryEntry[] = [];
  for (const m of memories) {
    if (m.ts >= cutoff) {
      recent.push(m);
    } else {
      older.push(m);
    }
  }
  return { recent, older };
}

export function assembleCurationPrompt(params: {
  recentMemories: MemoryEntry[];
  longtermSummary: string | null;
  curatorMd: string | null;
  pendingEngrams: Engram[];
  author: string;
  selectivity?: 'low' | 'medium' | 'high';
  granularity?: 'detailed' | 'summary';
  maxMemoriesPerRun?: number;
}): string {
  const longtermText = params.longtermSummary ?? '(no long-term context yet)';

  const recentText = params.recentMemories.length > 0
    ? params.recentMemories
        .map(m => `- [${m.ts}] ${m.author}: ${m.content}`)
        .join('\n')
    : '(no recent memories)';

  const curatorMdText = params.curatorMd ?? '(none provided)';

  const engramsText = params.pendingEngrams
    .map(e => `- [${e.created_at}] (id: ${e.id}) ${e.content}`)
    .join('\n');

  let prompt = BASE_CURATION_PROMPT
    .replace('{longterm_summary}', longtermText)
    .replace('{recent_memories}', recentText)
    .replace('{curator_md}', curatorMdText)
    .replace('{pending_engrams}', engramsText);

  // Append tuning instructions based on config
  const tuning: string[] = [];

  if (params.selectivity === 'high') {
    tuning.push('Be very selective. Only promote clearly significant events: major decisions, shipped deliverables, critical blockers, direction changes. Skip routine commits, minor fixes, and incremental progress.');
  } else if (params.selectivity === 'low') {
    tuning.push('Be inclusive. Promote most work events that have any team relevance. Only drop purely administrative or personal events.');
  }

  if (params.granularity === 'summary') {
    tuning.push('Consolidate related events into single memory entries. Prefer fewer, broader memories over many specific ones.');
  } else if (params.granularity === 'detailed') {
    tuning.push('Keep memories specific and granular. Each distinct event or decision should be its own memory entry. Do not roll up multiple events into one.');
  }

  if (params.maxMemoriesPerRun && params.maxMemoriesPerRun > 0) {
    tuning.push(`Produce at most ${params.maxMemoriesPerRun} memory entries from this batch. If more events are significant, prioritize the most important.`);
  }

  if (tuning.length > 0) {
    prompt += '\n\nAdditional instructions:\n' + tuning.map(t => `- ${t}`).join('\n');
  }

  return prompt;
}

export function parseMemoriesJsonl(content: string): MemoryEntry[] {
  if (!content.trim()) return [];
  const entries: MemoryEntry[] = [];
  for (const line of content.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.content === 'string') {
        entries.push({
          ts: parsed.ts ?? '',
          author: parsed.author ?? 'unknown',
          content: parsed.content,
          source_ids: Array.isArray(parsed.source_ids) ? parsed.source_ids : [],
        });
      }
    } catch {
      // Skip malformed lines — don't crash on corrupted JSONL
    }
  }
  return entries;
}

export async function runCuration(prompt: string): Promise<MemoryEntry[]> {
  let result = '';

  for await (const message of query({
    prompt,
    options: {
      systemPrompt: 'You are a memory curator. Respond only with a valid JSON array. No markdown, no code fences, no explanation.',
      tools: [],
      model: 'claude-sonnet-4-6',
      persistSession: false,
    },
  })) {
    if ('result' in message && typeof message.result === 'string') {
      result = message.result;
    }
  }

  if (!result) {
    throw new Error('No result returned from curation');
  }

  // Strip markdown code fences if present
  let cleaned = result.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  const raw = JSON.parse(cleaned);

  if (!Array.isArray(raw)) {
    throw new Error('Curation returned non-array response');
  }

  // Validate and normalize each entry
  const entries: MemoryEntry[] = raw.map((item: unknown, i: number) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Curation entry ${i} is not an object`);
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.content !== 'string' || !obj.content) {
      throw new Error(`Curation entry ${i} is missing content`);
    }
    return {
      ts: typeof obj.ts === 'string' ? obj.ts : new Date().toISOString(),
      author: typeof obj.author === 'string' ? obj.author : 'unknown',
      content: obj.content,
      source_ids: Array.isArray(obj.source_ids) ? obj.source_ids.filter((id): id is string => typeof id === 'string') : [],
    };
  });

  return entries;
}

export async function runConsolidation(existingLongterm: string | null, agingMemories: MemoryEntry[]): Promise<string> {
  const existingText = existingLongterm ?? '(no existing summary)';
  const agingText = agingMemories
    .map(m => `- [${m.ts}] ${m.author}: ${m.content}`)
    .join('\n');

  const prompt = CONSOLIDATION_PROMPT
    .replace('{existing_longterm}', existingText)
    .replace('{aging_memories}', agingText);

  let result = '';

  for await (const message of query({
    prompt,
    options: {
      systemPrompt: 'You are a memory consolidator. Return only the updated summary text. No JSON, no formatting.',
      tools: [],
      model: 'claude-sonnet-4-6',
      persistSession: false,
    },
  })) {
    if ('result' in message && typeof message.result === 'string') {
      result = message.result;
    }
  }

  if (!result) {
    throw new Error('No result returned from consolidation');
  }

  return result.trim();
}
