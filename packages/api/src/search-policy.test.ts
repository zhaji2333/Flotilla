import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeSearchQuery } from './search-policy.js';

test('disabled policy never lets a query out', () => {
  const result = sanitizeSearchQuery('CVE-2025-1234 exploit', 'https://app.example.com', 'disabled');
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /disabled/);
});

test('allowed passes the query through unchanged', () => {
  const result = sanitizeSearchQuery('example.com Apache 2.4.49 CVE', 'https://app.example.com', 'allowed');
  assert.equal(result.ok, true);
  assert.equal(result.query, 'example.com Apache 2.4.49 CVE');
});

test('limited masks the authorized host, IP and secrets but keeps technical terms', () => {
  const result = sanitizeSearchQuery(
    'app.example.com 10.20.30.40 CVE-2025-1234 exploit password=Hunter2',
    'https://app.example.com',
  );
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.query, /app\.example\.com/);
  assert.doesNotMatch(result.query, /10\.20\.30\.40/);
  assert.doesNotMatch(result.query, /Hunter2/);
  assert.match(result.query, /CVE-2025-1234/);
  assert.ok(result.masked.includes('target'));
});

test('limited blocks queries that are only target material', () => {
  const result = sanitizeSearchQuery('app.example.com', 'https://app.example.com', 'limited');
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /masking/);
});
