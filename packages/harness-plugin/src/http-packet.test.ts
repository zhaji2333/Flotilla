import { describe, expect, it } from 'vitest';
import { buildRawRequest } from './http-packet.js';

describe('raw request evidence', () => {
  it('includes a request line, explicit Host and headers', () => {
    const packet = buildRawRequest('GET', 'http://192.168.79.165:64280/api/v2/health?probe=1', {
      'User-Agent': 'Mozilla/5.0 test',
      Accept: 'application/json',
    });
    expect(packet.split('\n')[0]).toBe('GET /api/v2/health?probe=1 HTTP/1.1');
    expect(packet).toContain('Host: 192.168.79.165:64280');
    expect(packet).toContain('User-Agent: Mozilla/5.0 test');
  });

  it('does not duplicate a caller-supplied Host header', () => {
    const packet = buildRawRequest('POST', 'https://real.example.test/login', { Host: 'evil.test' }, 'a=1');
    expect(packet.match(/^Host:/gm)?.length).toBe(1);
    expect(packet).toContain('Host: real.example.test');
    expect(packet).toContain('\n\na=1');
  });
});
