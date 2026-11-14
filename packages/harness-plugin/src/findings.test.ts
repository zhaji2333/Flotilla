import { describe, expect, it } from 'vitest';
import { recordFinding } from './findings.js';
import { TrafficStore } from './store.js';

function storeWithTwoExchanges(): TrafficStore {
  const store = new TrafficStore();
  store.record({
    kind: 'target',
    method: 'GET',
    url: 'http://target.test/api/health',
    statusCode: 200,
    requestText: 'GET /api/health HTTP/1.1\nHost: target.test\nUser-Agent: test',
    responseText: 'HTTP/1.1 200 OK\n\n{"ok":true}',
  });
  store.record({
    kind: 'target',
    method: 'POST',
    url: 'http://target.test/api/login',
    statusCode: 200,
    requestText: 'POST /api/login HTTP/1.1\nHost: target.test\nUser-Agent: test',
    responseText: 'HTTP/1.1 200 OK\n\n{"ok":true,"role":"admin"}',
  });
  return store;
}

describe('recordFinding', () => {
  it('records a finding backed by two real traffic records', () => {
    const store = storeWithTwoExchanges();
    const result = recordFinding(store, 'http://target.test', {
      title: 'Auth bypass',
      category: 'auth',
      severity: 'high',
      artifact: 'FLAG{demo}',
      evidence: ['tr_1', 'tr_2'],
    });
    expect(result.status).toBe('recorded');
    if (result.status === 'recorded') {
      expect(result.finding.status).toBe('accepted');
      expect(result.finding.evidence).toHaveLength(2);
      expect(result.finding.reportMd).toContain('【高危】');
      expect(result.finding.reportMd).toContain('## 完整请求 / 响应');
      expect(result.finding.artifact).toBe('FLAG{demo}');
    }
  });

  it('rejects fewer than two evidence refs', () => {
    const store = storeWithTwoExchanges();
    const result = recordFinding(store, 'http://target.test', {
      title: 'x', category: 'x', severity: 'low', evidence: ['tr_1'],
    });
    expect(result.status).toBe('rejected');
  });

  it('rejects unknown traffic ids instead of fabricating evidence', () => {
    const store = storeWithTwoExchanges();
    const result = recordFinding(store, 'http://target.test', {
      title: 'x', category: 'x', severity: 'low', evidence: ['tr_1', 'tr_999'],
    });
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason).toContain('tr_999');
  });

  it('rejects duplicate refs', () => {
    const store = storeWithTwoExchanges();
    const result = recordFinding(store, 'http://target.test', {
      title: 'x', category: 'x', severity: 'low', evidence: ['tr_1', 'tr_1'],
    });
    expect(result.status).toBe('rejected');
  });
});
