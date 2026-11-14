import { describe, expect, it } from 'vitest';
import { extractCandidates, inlineSourceMap, isJavaScriptResource, sourceMapDirective } from './network.js';

describe('browser network parsing', () => {
  it('extracts absolute URLs and API paths', () => {
    const candidates = extractCandidates('fetch("/api/v1/users?x=1"); const u="https://api.example.com/v2/a";');
    expect(candidates).toContain('https://api.example.com/v2/a');
    expect(candidates).toContain('/api/v1/users?x=1');
  });

  it('detects chunks and source maps', () => {
    expect(isJavaScriptResource('http://x/static/js/app.js', 'script')).toBe(true);
    expect(isJavaScriptResource('http://x/static/js/app.js.map', 'other')).toBe(true);
    expect(sourceMapDirective('foo\n//# sourceMappingURL=app.js.map')).toBe('app.js.map');
    const inline = '//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify({sourcesContent: ['/api/v3/hidden']})).toString('base64');
    expect(inlineSourceMap(inline)).toContain('/api/v3/hidden');
  });
});
