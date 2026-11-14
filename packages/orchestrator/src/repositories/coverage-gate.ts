// ── Coverage completion gate ────────────────────────────────
// Mirrors the "coverage" goal family: a mission may require observed assets to
// be covered before it can complete. Kept pure so the DB aggregation and the
// policy can be tested independently.

export interface CoverageGateConfig {
  enabled?: boolean;
  minRatio?: number;
  requireAcceptedFinding?: boolean;
}

export interface CoverageGateResult {
  required: boolean;
  total: number;
  covered: number;
  ratio: number | null;
  minRatio: number;
  passed: boolean;
  failure?: 'coverage_no_assets' | 'coverage_below_target';
}

export function evaluateCoverageGate(
  config: CoverageGateConfig | undefined,
  total: number,
  covered: number,
  acceptedFindings: number,
): CoverageGateResult | null {
  if (!config || config.enabled === false) return null;
  const minRatio = Math.max(0, Math.min(1, Number(config.minRatio ?? 1)));
  const ratio = total > 0 ? covered / total : null;
  const passed = total > 0 && ratio !== null && ratio >= minRatio && (!config.requireAcceptedFinding || acceptedFindings > 0);
  return {
    required: true,
    total,
    covered,
    ratio,
    minRatio,
    passed,
    ...(passed ? {} : { failure: total === 0 ? 'coverage_no_assets' as const : 'coverage_below_target' as const }),
  };
}
