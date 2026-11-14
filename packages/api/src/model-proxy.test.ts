import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeUpstreamBase, rewriteModel } from './model-proxy.js';
import { deepseekToolUrl } from './tools-proxy.js';

describe('model proxy helpers', () => {
  it('adds /v1 for a provider origin and preserves explicit paths', () => {
    assert.equal(normalizeUpstreamBase('https://api.deepseek.com'), 'https://api.deepseek.com/v1');
    assert.equal(normalizeUpstreamBase('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
    assert.equal(normalizeUpstreamBase('http://127.0.0.1:8080/api'), 'http://127.0.0.1:8080/api');
  });

  it('rewrites the model and normalizes developer messages', () => {
    const body = rewriteModel(Buffer.from(JSON.stringify({
      model: 'client-model',
      messages: [{ role: 'developer', content: 'guard' }, { role: 'user', content: 'hi' }],
    })), 'guard-model');
    const parsed = JSON.parse(body.toString('utf8')) as { model: string; messages: Array<{ role: string }> };
    assert.equal(parsed.model, 'guard-model');
    assert.deepEqual(parsed.messages.map(message => message.role), ['system', 'user']);
  });

  it('leaves non-JSON bodies untouched', () => {
    const raw = Buffer.from('not json');
    assert.equal(rewriteModel(raw, 'guard-model').toString('utf8'), 'not json');
  });
});


describe('DeepSeek tools proxy URL', () => {
  it('uses /v1/tools without duplicating /v1', () => {
    assert.equal(deepseekToolUrl('https://api.deepseek.com', 'search'), 'https://api.deepseek.com/v1/tools/search');
    assert.equal(deepseekToolUrl('https://api.deepseek.com/v1/', 'fetch'), 'https://api.deepseek.com/v1/tools/fetch');
  });

  it('preserves a custom provider prefix', () => {
    assert.equal(deepseekToolUrl('https://gateway.example/v1', 'search'), 'https://gateway.example/v1/tools/search');
  });
});
