// ── Model key pool ──────────────────────────────────────────
// A single provider key is a throughput bottleneck: one 429 pauses every
// worker. The pool rotates keys per attempt and parks a key that returned a
// transient failure for a short cooldown. It is deliberately small and
// deterministic; provider-specific routing stays in the Harness adapter.

export interface ModelKeyPoolOptions {
  keys?: string[];
  cooldownMs?: number;
  now?: () => number;
}

export class ModelKeyPool {
  private readonly keys: string[];
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly coolingUntil = new Map<string, number>();
  private cursor = 0;
  private lastKey: string | undefined;

  constructor(options: ModelKeyPoolOptions = {}) {
    this.keys = [...new Set((options.keys ?? []).map(key => key.trim()).filter(Boolean))];
    this.cooldownMs = Math.max(1_000, options.cooldownMs ?? 60_000);
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.keys.length;
  }

  /** Returns the next usable key, or undefined when no key is configured. */
  next(): string | undefined {
    if (this.keys.length === 0) return undefined;
    const time = this.now();
    for (let offset = 0; offset < this.keys.length; offset += 1) {
      const index = (this.cursor + offset) % this.keys.length;
      const key = this.keys[index]!;
      const until = this.coolingUntil.get(key) ?? 0;
      if (until <= time) {
        this.cursor = (index + 1) % this.keys.length;
        this.lastKey = key;
        return key;
      }
    }
    // All keys are cooling down: choose the one that recovers first.
    const [key] = [...this.keys].sort((a, b) => (this.coolingUntil.get(a) ?? 0) - (this.coolingUntil.get(b) ?? 0));
    this.lastKey = key;
    return key;
  }

  /** Parks the key used by the failed attempt. */
  reportFailure(key = this.lastKey): void {
    if (!key) return;
    this.coolingUntil.set(key, this.now() + this.cooldownMs);
  }

  reportSuccess(key = this.lastKey): void {
    if (key) this.coolingUntil.delete(key);
  }
}

/** Parses comma/newline separated keys, falling back to the legacy single key. */
export function loadModelKeyPool(env: NodeJS.ProcessEnv = process.env): ModelKeyPool {
  const many = env.LLM_API_KEYS?.split(/[,\n]/).map(key => key.trim()).filter(Boolean) ?? [];
  const keys = many.length > 0 ? many : (env.LLM_API_KEY ? [env.LLM_API_KEY] : []);
  return new ModelKeyPool({
    keys,
    cooldownMs: Math.max(1_000, Number(env.LLM_KEY_COOLDOWN_MS || 60_000)),
  });
}
