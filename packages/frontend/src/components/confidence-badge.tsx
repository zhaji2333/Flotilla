import type { Confidence } from '../lib/types';
import { confidenceLabel } from '../lib/format';
import { cn } from '../lib/utils';

const TONE: Record<Confidence, string> = {
  observed: 'text-emerald-300 border-emerald-300/45 bg-emerald-300/5',
  inferred: 'text-sky border-sky/45 bg-sky/5',
  unverified: 'text-amber-300 border-amber-300/45 bg-amber-300/5',
};

export function ConfidenceBadge({ confidence, className }: { confidence: Confidence | string; className?: string }) {
  const value = (confidence || 'unverified') as Confidence;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.12em]', TONE[value] ?? TONE.unverified, className)}>
      {confidenceLabel(value)}
    </span>
  );
}
