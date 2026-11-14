import { readFile } from 'node:fs/promises';

// ── Shared hint file channel ────────────────────────────────
// The worker appends one JSON string per line while the executor job runs. The
// executor reads only lines written since its previous poll, so retries and
// repeated polls cannot re-inject the same hint.

export function createHintFileReader(path: string): () => Promise<string[]> {
  let consumedBytes = 0;
  return async () => {
    let raw: Buffer;
    try {
      raw = await readFile(path);
    } catch {
      return [];
    }
    if (raw.length <= consumedBytes) return [];
    const chunk = raw.subarray(consumedBytes);
    const newline = chunk.lastIndexOf(0x0a);
    if (newline < 0) return [];
    consumedBytes += newline + 1;
    const hints: string[] = [];
    for (const line of chunk.subarray(0, newline).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === 'string' && parsed.trim()) hints.push(parsed);
      } catch {
        // A malformed line is ignored; the next poll sees the next newline.
      }
    }
    return hints;
  };
}
