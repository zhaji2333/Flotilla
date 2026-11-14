import { describe, expect, it } from 'vitest';
import { parseDeepSeekSearchResults } from './tools.js';

describe('DeepSeek search result parser', () => {
  it('extracts structured search results and keeps DeepSeek ranking metadata', () => {
    const results = parseDeepSeekSearchResults({
      results: [
        { title: 'PoC repo', url: 'https://github.com/acme/poc', snippet: 'snippet', summary: 'summary', content: '', site_name: 'GitHub', date: '2026-01-01T00:00:00+00:00', authority: 3, rerank_score: 2.4 },
        { title: 'no url', snippet: 'ignored' },
      ],
    }, 5);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: 'PoC repo',
      url: 'https://github.com/acme/poc',
      summary: 'summary',
      siteName: 'GitHub',
      authority: 3,
      rerankScore: 2.4,
    });
  });

  it('honours the result limit and invalid payloads', () => {
    const results = parseDeepSeekSearchResults({ results: Array.from({ length: 4 }, (_, index) => ({ title: `r${index}`, url: `https://example.com/${index}` })) }, 2);
    expect(results).toHaveLength(2);
    expect(parseDeepSeekSearchResults(null)).toEqual([]);
    expect(parseDeepSeekSearchResults({ results: 'not-array' })).toEqual([]);
  });
});
