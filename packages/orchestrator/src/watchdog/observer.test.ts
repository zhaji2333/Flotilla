import { describe, expect, it } from 'vitest';
import { watchdogConfigFromEnv } from './observer.js';

describe('external watchdog config', () => {
  it('uses bounded defaults', () => {
    const config = watchdogConfigFromEnv({} as NodeJS.ProcessEnv);
    expect(config.windowMinutes).toBe(10);
    expect(config.duplicateThreshold).toBe(10);
    expect(config.noProgressMinutes).toBe(15);
    expect(config.maxObservations).toBe(20);
  });

  it('clamps unsafe values', () => {
    const config = watchdogConfigFromEnv({
      WATCHDOG_WINDOW_MINUTES: '0',
      WATCHDOG_DUPLICATE_THRESHOLD: '-1',
      WATCHDOG_NO_PROGRESS_MINUTES: '0',
      WATCHDOG_MAX_OBSERVATIONS: '999',
    } as NodeJS.ProcessEnv);
    expect(config.windowMinutes).toBeGreaterThanOrEqual(1);
    expect(config.duplicateThreshold).toBeGreaterThanOrEqual(1);
    expect(config.noProgressMinutes).toBeGreaterThanOrEqual(1);
    expect(config.maxObservations).toBe(100);
  });
});
