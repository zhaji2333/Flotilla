import { describe, expect, it } from 'vitest';
import { TrafficStore, sha256 } from './store.js';

describe('TrafficStore', () => {
  it('records exchanges with stable ids and hashes', () => {
    const store = new TrafficStore();
    const record = store.record({
      kind: 'target',
      method: 'GET',
      url: 'http://target.test/robots.txt',
      statusCode: 200,
      requestText: 'GET http://target.test/robots.txt',
      responseText: 'User-agent: *',
    });
    expect(record.id).toBe('tr_1');
    expect(record.requestSha256).toBe(sha256('GET http://target.test/robots.txt'));
    expect(record.responseSha256).toBe(sha256('User-agent: *'));
    expect(record.untrusted).toBe(false);
    expect(store.record({ kind: 'internet', method: 'GET', url: 'https://example.com', statusCode: 200, requestText: 'r', responseText: 's' }).untrusted).toBe(true);
  });

  it('searches by host and body substring', () => {
    const store = new TrafficStore();
    store.record({ kind: 'target', method: 'GET', url: 'http://target.test/a', statusCode: 200, requestText: 'GET /a', responseText: 'alpha' });
    store.record({ kind: 'target', method: 'POST', url: 'http://target.test/login', statusCode: 500, requestText: 'POST /login', responseText: 'syntax error near' });
    expect(store.search({ host: 'login' })).toHaveLength(1);
    expect(store.search({ bodyContains: 'SYNTAX' })).toHaveLength(1);
    expect(store.search({ bodyContains: 'nope' })).toHaveLength(0);
  });

  it('deduplicates assets by type and value', () => {
    const store = new TrafficStore();
    store.insertAssets([{ type: 'host', value: 'target.test' }]);
    store.insertAssets([{ type: 'host', value: 'target.test' }, { type: 'api', value: '/login' }]);
    expect(store.listAssets()).toHaveLength(2);
    expect(store.listAssets('api')).toHaveLength(1);
  });
});
