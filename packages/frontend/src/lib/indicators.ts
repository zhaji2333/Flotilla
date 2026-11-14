import type { Indicator, IndicatorGroup, IndicatorUnit } from './types';
import { formatSeconds } from './format';

// P3-A2: the backend owns the 13-metric catalog. The UI must not recompute
// ratios; it formats the provided value and treats null as N/A.
export const INDICATOR_GROUP_ORDER: IndicatorGroup[] = ['quality', 'efficiency', 'safety', 'control'];

export const INDICATOR_GROUP_LABELS: Record<IndicatorGroup, string> = {
  quality: '质量',
  efficiency: '效率',
  safety: '安全',
  control: '控制',
};

const UNIT_LABELS: Record<IndicatorUnit, string> = {
  count: '',
  ratio: '',
  seconds: '',
  tokens: 'tokens / validated finding',
};

export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

export function formatIndicatorValue(indicator: Pick<Indicator, 'unit' | 'value'>): string {
  if (indicator.value === null || indicator.value === undefined || Number.isNaN(indicator.value)) return 'N/A';
  switch (indicator.unit) {
    case 'ratio':
      return `${(indicator.value * 100).toFixed(1)}%`;
    case 'seconds':
      return formatSeconds(indicator.value);
    case 'tokens':
      return compactNumber(indicator.value);
    case 'count':
    default:
      return Number.isInteger(indicator.value) ? String(indicator.value) : indicator.value.toFixed(1);
  }
}

export function indicatorUnitLabel(unit: IndicatorUnit): string {
  return UNIT_LABELS[unit];
}

export function groupIndicators(indicators: Indicator[]): Array<{ group: IndicatorGroup; label: string; items: Indicator[] }> {
  return INDICATOR_GROUP_ORDER
    .map(group => ({
      group,
      label: INDICATOR_GROUP_LABELS[group],
      items: indicators.filter(indicator => indicator.group === group),
    }))
    .filter(entry => entry.items.length > 0);
}

export function indicatorHint(indicator: Indicator): string {
  const denominator = indicator.denominator === null ? '—' : compactNumber(indicator.denominator);
  const numerator = indicator.numerator === null ? '—' : compactNumber(indicator.numerator);
  return `${indicator.definition}\n口径：${numerator} / ${denominator}`;
}
