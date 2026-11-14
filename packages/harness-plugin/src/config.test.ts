import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const baseEnv = {
  SRC_AGENT_MISSION_ID: 'mission-1',
  SRC_AGENT_TASK_ID: 'task-1',
  SRC_AGENT_TARGET_URL: 'http://host.docker.internal:64280/',
  SRC_AGENT_SCOPE_JSON: JSON.stringify({
    domainSuffixes: [],
    ips: ['0.250.250.254/32'],
    urlPrefixes: [{ prefix: 'http://host.docker.internal:64280', ports: [64280] }],
    exclude: [],
  }),
};

describe('loadConfig', () => {
  it('returns null outside a mission so bare harness runs still boot', () => {
    expect(loadConfig({})).toBeNull();
  });

  it('parses mission config and normalizes the target', () => {
    const config = loadConfig(baseEnv);
    expect(config).not.toBeNull();
    if (config?.role !== 'worker') throw new Error('expected worker config');
    expect(config.targetUrl).toBe('http://host.docker.internal:64280');
    expect(config.scope.ips).toEqual(['0.250.250.254/32']);
    expect(config.reportPath).toBe('/tmp/src-agent-report.json');
    expect(config.traceSearchEnabled).toBe(true);
    expect(config.requestDedupeMode).toBe('warn');
  });

  it('honours the runtime dedupe mode', () => {
    const config = loadConfig({ ...baseEnv, REQUEST_DEDUPE_MODE: 'off' });
    if (config?.role !== 'worker') throw new Error('expected worker config');
    expect(config.requestDedupeMode).toBe('off');
  });

  it('honours explicit proxy/report/budget settings', () => {
    const config = loadConfig({
      ...baseEnv,
      SRC_AGENT_PROXY_URL: 'http://127.0.0.1:8080',
      SRC_AGENT_REPORT_PATH: '/tmp/report.json',
    });
    if (config?.role !== 'worker') throw new Error('expected worker config');
    expect(config.proxyUrl).toBe('http://127.0.0.1:8080');
    expect(config.reportPath).toBe('/tmp/report.json');
  });

  it('parses the dynamic mission API endpoint and token', () => {
    const config = loadConfig({
      ...baseEnv,
      SRC_AGENT_MISSION_API_URL: 'http://api:3001/',
      SRC_AGENT_MISSION_API_TOKEN: 'readonly-token',
    });
    if (config?.role !== 'worker') throw new Error('expected worker config');
    expect(config.missionApiUrl).toBe('http://api:3001');
    expect(config.missionApiToken).toBe('readonly-token');
  });

  it('parses the planner role without target tools', () => {
    const config = loadConfig({
      SRC_AGENT_ROLE: 'planner',
      SRC_AGENT_PLANNER_STATE_PATH: '/tmp/state.json',
      SRC_AGENT_PLANNER_PLAN_PATH: '/tmp/plan.json',
    });
    expect(config).toEqual({ role: 'planner', statePath: '/tmp/state.json', planPath: '/tmp/plan.json' });
    expect(() => loadConfig({ SRC_AGENT_ROLE: 'planner' })).toThrow(/SRC_AGENT_PLANNER_STATE_PATH/);
  });

  it('rejects partial mission configuration', () => {
    expect(() => loadConfig({ SRC_AGENT_MISSION_ID: 'm-1' })).toThrow(/incomplete/);
  });

  it('rejects invalid scope JSON', () => {
    expect(() => loadConfig({ ...baseEnv, SRC_AGENT_SCOPE_JSON: '{' })).toThrow(/not valid JSON/);
  });
});
