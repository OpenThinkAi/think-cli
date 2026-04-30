// Format any thrown or collected sync error as a single readable line.
// Sync callers (curate, memory add, cortex push) used to swallow these and
// print a generic "remote unavailable" message, which hid real failures like
// SSH auth errors — see hivedb#4. Showing the first line of the actual error
// preserves the signal without dumping multi-line stack traces on the user.
export function formatSyncError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = raw.split('\n').map(s => s.trim()).find(Boolean) ?? raw;
  const MAX = 200;
  return firstLine.length > MAX ? firstLine.slice(0, MAX - 1) + '…' : firstLine;
}
