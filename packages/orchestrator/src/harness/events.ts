// ── Harness run-event parsing ───────────────────────────────
// `dsh --json` writes newline-delimited run events to stdout. The worker tails
// them for budget enforcement and keeps the final summary for the task row.

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export interface RunSummary {
  sessionId?: string;
  steps: number;
  toolCalls: number;
  tokenUsage: TokenUsage;
  finalText: string;
  completed: boolean;
  error?: string;
}

export interface RunEventAccumulator {
  observe(line: string): void;
  summary(): RunSummary;
  steps(): number;
  tokens(): number;
}

interface RawEvent {
  type?: string;
  sessionId?: string;
  phase?: string;
  step?: number;
  text?: string;
  tool?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  reason?: { kind?: string; error?: { message?: string } };
}

export function createRunEventAccumulator(): RunEventAccumulator {
  let sessionId: string | undefined;
  let steps = 0;
  let toolCalls = 0;
  let input = 0;
  let output = 0;
  let total = 0;
  let finalText = '';
  let completed = false;
  let error: string | undefined;
  let streamedText = '';

  return {
    observe(line: string) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      let event: RawEvent;
      try {
        event = JSON.parse(trimmed) as RawEvent;
      } catch {
        return;
      }
      if (event.type === 'session' && typeof event.sessionId === 'string') {
        sessionId = event.sessionId;
      } else if (event.type === 'status' && event.phase === 'step_end') {
        if (typeof event.step === 'number') steps = Math.max(steps, event.step);
        if (event.usage) {
          input += event.usage.inputTokens ?? 0;
          output += event.usage.outputTokens ?? 0;
          total += event.usage.totalTokens ?? (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0);
        }
      } else if (event.type === 'tool_call') {
        toolCalls += 1;
      } else if (event.type === 'text' && typeof event.text === 'string') {
        streamedText += event.text;
      } else if (event.type === 'final') {
        if (typeof event.sessionId === 'string') sessionId = event.sessionId;
        if (typeof event.text === 'string' && event.text.trim()) finalText = event.text;
        completed = event.reason?.kind === 'completed';
        if (event.reason?.error?.message) error = event.reason.error.message;
      }
    },
    summary(): RunSummary {
      return {
        sessionId,
        steps,
        toolCalls,
        tokenUsage: { input, output, total },
        finalText: finalText || streamedText,
        completed,
        error,
      };
    },
    steps() {
      return steps;
    },
    tokens() {
      return total;
    },
  };
}
