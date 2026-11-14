import { describe, expect, it } from 'vitest';
import { approvalTypeLabel, confidenceLabel, formatBytes, formatDate, formatRate, formatSeconds, missionLabel, severityLabel, taskLabel } from './format';

describe('contract display labels', () => {
  it('keeps the raw enum value next to the Chinese label', () => {
    expect(missionLabel('running')).toBe('运行中 (running)');
    expect(missionLabel('paused')).toBe('已暂停 (paused)');
    expect(taskLabel('retry_wait')).toBe('等待重试 (retry_wait)');
    expect(severityLabel('critical')).toBe('严重 (critical)');
  });

  it('formats time in Asia/Shanghai', () => {
    expect(formatDate('2026-01-01T00:00:00.000Z')).toContain('2026');
    expect(formatDate(null)).toBe('—');
  });

  it('labels P2 confidence and formats metrics values', () => {
    expect(confidenceLabel('observed')).toBe('已观测 (observed)');
    expect(confidenceLabel('unverified')).toBe('未验证 (unverified)');
    expect(formatRate(0.152)).toBe('15%');
    expect(formatRate(0.021)).toBe('2.1%');
    expect(formatRate(null)).toBe('—');
    expect(formatSeconds(59)).toBe('59s');
    expect(formatSeconds(125)).toBe('2m 5s');
  });

  it('labels watchdog stall reviews as a first-class approval type', () => {
    expect(approvalTypeLabel('stalled_task')).toBe('停滞任务复核 (stalled_task)');
    expect(approvalTypeLabel('manual')).toBe('人工审批 (manual)');
  });

  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(-1)).toBe('—');
  });
});
