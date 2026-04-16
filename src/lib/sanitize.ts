export const MAX_ENGRAM_LENGTH = 4000;

const SUSPICIOUS_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?above\s+instructions/i,
  /override\s+(all\s+)?(previous\s+)?instructions/i,
  /system\s*:?\s*(prompt|instruction|override)/i,
  /you\s+are\s+now\s+(a|an|configured|instructed)/i,
  /new\s+instructions?\s*:/i,
  /disregard\s+(all\s+)?(previous|above|prior)/i,
  /forget\s+(all\s+)?(previous|above|prior)\s+(instructions|rules)/i,
  /\bdo\s+not\s+evaluate\b/i,
  /\brespond\s+only\s+with\b/i,
];

export function validateEngramContent(content: string): {
  content: string;
  warnings: string[];
} {
  const warnings: string[] = [];

  if (content.length > MAX_ENGRAM_LENGTH) {
    content = content.slice(0, MAX_ENGRAM_LENGTH);
    warnings.push(`Content truncated to ${MAX_ENGRAM_LENGTH} characters`);
  }

  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(content)) {
      warnings.push('Content contains patterns that resemble prompt injection');
      break;
    }
  }

  return { content, warnings };
}

export function wrapData(label: string, content: string): string {
  return `<data source="${label}">\n${content}\n</data>`;
}
