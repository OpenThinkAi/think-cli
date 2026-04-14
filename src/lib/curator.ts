import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getCuratorMdPath } from './paths.js';
import type { Engram } from '../db/engram-queries.js';

export interface MemoryEntry {
  ts: string;
  author: string;
  content: string;
  source_ids: string[];
}

const BASE_CURATION_PROMPT = `You are a memory curator. You evaluate recent work events and decide which ones are significant enough to become shared team memory.

## What the team already knows
{existing_memories}

## What this contributor considers worth sharing
{curator_md}

## Recent work events to evaluate
{pending_engrams}

---

Your task:

1. Read what the team already knows to avoid redundancy.
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

export function readCuratorMd(): string | null {
  const mdPath = getCuratorMdPath();
  if (fs.existsSync(mdPath)) {
    return fs.readFileSync(mdPath, 'utf-8').trim();
  }
  return null;
}

export function assembleCurationPrompt(params: {
  existingMemories: MemoryEntry[];
  curatorMd: string | null;
  pendingEngrams: Engram[];
  author: string;
}): string {
  const memoriesText = params.existingMemories.length > 0
    ? params.existingMemories
        .map(m => `- [${m.ts}] ${m.author}: ${m.content}`)
        .join('\n')
    : '(no memories yet)';

  const curatorMdText = params.curatorMd ?? '(none provided)';

  const engramsText = params.pendingEngrams
    .map(e => `- [${e.created_at}] (id: ${e.id}) ${e.content}`)
    .join('\n');

  return BASE_CURATION_PROMPT
    .replace('{existing_memories}', memoriesText)
    .replace('{curator_md}', curatorMdText)
    .replace('{pending_engrams}', engramsText);
}

export function parseMemoriesJsonl(content: string): MemoryEntry[] {
  if (!content.trim()) return [];
  return content.trim().split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as MemoryEntry);
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

  const entries = JSON.parse(cleaned) as MemoryEntry[];

  if (!Array.isArray(entries)) {
    throw new Error('Curation returned non-array response');
  }

  return entries;
}
