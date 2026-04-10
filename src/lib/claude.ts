import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Entry } from '../db/queries.js';

const SYSTEM_PROMPT = `You are a professional assistant that creates well-organized weekly summaries from work log entries. Your summaries are used in 1:1 meetings.

Instructions:
- Group entries by theme, NOT by day
- Highlight key accomplishments
- Note important decisions made
- Mention meetings and their outcomes
- Use a professional but concise tone
- Output in markdown format
- Use bullet points for clarity
- If entries span multiple categories, organize by topic rather than category`;

export async function generateSummary(entries: Entry[]): Promise<string> {
  const entriesText = entries
    .map((e) => {
      const ts = e.timestamp.slice(0, 16).replace('T', ' ');
      const tags = e.tags !== '[]' ? ` [tags: ${e.tags}]` : '';
      return `- ${ts} (${e.category}) ${e.content}${tags}`;
    })
    .join('\n');

  const prompt = `Here are my work log entries for this period:\n\n${entriesText}\n\nPlease create a well-organized summary suitable for a 1:1 meeting.`;

  let result = '';

  for await (const message of query({
    prompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
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
    throw new Error('No result returned from Claude');
  }

  return result;
}
