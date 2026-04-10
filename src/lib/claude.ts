import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from './config.js';
import type { Entry } from '../db/queries.js';

function getApiKey(): string {
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey) return envKey;

  const config = getConfig();
  if (config.anthropicApiKey) return config.anthropicApiKey;

  throw new Error(
    'No Anthropic API key found. Set ANTHROPIC_API_KEY env var or add anthropicApiKey to ~/.config/think/config.json'
  );
}

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
  const apiKey = getApiKey();
  const client = new Anthropic({ apiKey });

  const entriesText = entries
    .map((e) => {
      const ts = e.timestamp.slice(0, 16).replace('T', ' ');
      const tags = e.tags !== '[]' ? ` [tags: ${e.tags}]` : '';
      return `- ${ts} (${e.category}) ${e.content}${tags}`;
    })
    .join('\n');

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Here are my work log entries for this period:\n\n${entriesText}\n\nPlease create a well-organized summary suitable for a 1:1 meeting.`,
      },
    ],
  });

  const block = message.content[0];
  if (block.type === 'text') {
    return block.text;
  }
  throw new Error('Unexpected response format from Claude API');
}
