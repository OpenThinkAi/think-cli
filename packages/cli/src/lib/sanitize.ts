export const MAX_ENGRAM_LENGTH = 4000;

/**
 * Strip ANSI/control characters from a daemon-sourced string before printing.
 * The daemon socket is an IPC boundary -- a rogue responder could otherwise
 * inject OSC/CSI sequences into the terminal. Covers both the C0 range
 * (\x00-\x1f, DEL) and the 8-bit C1 range (\x80-\x9f), which includes the
 * 8-bit CSI equivalent at \x9b.
 *
 * Apply to all strings sourced from daemon RPC results before writing to
 * stdout/stderr. User-supplied strings echoed back to the same user do NOT
 * need this treatment -- only daemon-sourced strings.
 */
export function stripControls(s: unknown): string {
  return String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

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
  // Escape data tags in content to prevent delimiter breakout and fake block injection
  const escaped = content.replace(/<\/?data/gi, (match) => `&lt;${match.slice(1)}`);
  return `<data source="${label}">\n${escaped}\n</data>`;
}

/**
 * Strip embedded newlines from a value before interpolating into a single-line
 * output (log line, JSON warning string, user-facing message). Prevents log
 * injection and CRLF-in-display via crafted cortex names, entry IDs, or error
 * messages. Matches the pattern established by AGT-277 in embed-model-check.ts.
 */
export function sanitizeForLog(value: string): string {
  return value.replace(/[\r\n]/g, ' ');
}
