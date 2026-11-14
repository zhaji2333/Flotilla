import { describe, expect, it } from 'vitest';
import { compactNumber, formatIndicatorValue, groupIndicators, indicatorHint } from './indicators';
import type { Indicator } from './types';

const base: Indicator = {
  id: 'x',
  group: 'quality',
  label: 'x',
  unit: 'ratio',
  definition: 'def',
  value: 0.9785,
  numerator: 190,
  denominator: 194,
};

function indicator(overrides: Partial<Indicator>): Indicator {
  return { ...base, ...overrides };
}

describe('P3 indicator formatting', () => {
  it('formats each unit and N/A for null', () => {
    expect(formatIndicatorValue(indicator({ unit: 'ratio', value: 0.9785 }))).toBe('97.9%');
    expect(formatIndicatorValue(indicator({ unit: 'count', value: 190 }))).toBe('190');
    expect(formatIndicatorValue(indicator({ unit: 'seconds', value: 125 }))).toBe('2m 5s');
    expect(formatIndicatorValue(indicator({ unit: 'tokens', value: 212561 }))).toBe('212.6K');
    expect(formatIndicatorValue(indicator({ value: null }))).toBe('N/A');
  });

  it('keeps fixed group order and drops empty groups', () => {
    const groups = groupIndicators([
      indicator({ id: 'b', group: 'efficiency' }),
      indicator({ id: 'a', group: 'quality' }),
      indicator({ id: 'c', group: 'safety' }),
    ]);
    expect(groups.map(group => group.group)).toEqual(['quality', 'efficiency', 'safety']);
    expect(groups[0]?.items.map(item => item.id)).toEqual(['a']);
  });

  it('builds definition and numerator/denominator hints', () => {
    expect(indicatorHint(base)).toContain('def');
    expect(indicatorHint(base)).toContain('190 / 194');
    expect(compactNumber(1_500_000)).toBe('1.5M');
    expect(compactNumber(12)).toBe('12');
  });
});
