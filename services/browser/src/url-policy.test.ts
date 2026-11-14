import { describe, expect, it } from 'vitest';
import { assertNavigableUrl, isSafeSelector } from './url-policy.js';

describe('browser URL policy', () => {
  it('allows http(s) URLs only', () => {
    expect(assertNavigableUrl('http://127.0.0.1:65280/').protocol).toBe('http:');
    expect(assertNavigableUrl('https://example.com/a').protocol).toBe('https:');
    expect(() => assertNavigableUrl('file:///etc/passwd')).toThrow(/scheme/);
    expect(() => assertNavigableUrl('data:text/html,hi')).toThrow(/scheme/);
    expect(() => assertNavigableUrl('javascript:alert(1)')).toThrow(/scheme/);
    expect(() => assertNavigableUrl('http://user:pass@example.com/')).toThrow(/credentials/);
  });

  it('rejects empty selectors', () => {
    expect(isSafeSelector('button')).toBe(true);
    expect(isSafeSelector('')).toBe(false);
    expect(isSafeSelector(null)).toBe(false);
  });
});
