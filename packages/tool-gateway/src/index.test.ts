import { describe, it, expect } from 'vitest';
import {
  matchDomain, matchIp, checkScope, classifyRisk, systemBlock, markUntrusted,
  isExcluded, matchUrlPrefix, buildScopeForTarget,
} from '../src/index.js';
import type { GrantScope } from '@src-agent/contracts';

const scope: GrantScope = {
  domainSuffixes: ['example.com', 'test.org'],
  ips: ['10.0.0.0/8', '192.168.1.100'],
  urlPrefixes: [{ prefix: 'https://api.specific.com/v1/', ports: [443] }],
  exclude: ['admin.example.com', '*.internal.example.com'],
  allowAll: false,
};

describe('matchDomain', () => {
  it('matches exact domain', () => {
    expect(matchDomain('example.com', ['example.com'])).toBe(true);
  });
  it('matches subdomain', () => {
    expect(matchDomain('api.example.com', ['example.com'])).toBe(true);
  });
  it('matches deep subdomain', () => {
    expect(matchDomain('a.b.example.com', ['example.com'])).toBe(true);
  });
  it('rejects different domain', () => {
    expect(matchDomain('evil.com', ['example.com'])).toBe(false);
  });
  it('rejects partial match', () => {
    expect(matchDomain('notexample.com', ['example.com'])).toBe(false);
  });
});

describe('isExcluded', () => {
  it('excludes exact match', () => {
    expect(isExcluded('admin.example.com', scope.exclude)).toBe(true);
  });
  it('excludes subdomain of excluded', () => {
    expect(isExcluded('x.admin.example.com', scope.exclude)).toBe(true);
  });
  it('allows non-excluded', () => {
    expect(isExcluded('api.example.com', scope.exclude)).toBe(false);
  });
});

describe('matchIp', () => {
  it('matches exact IP', () => {
    expect(matchIp('192.168.1.100', scope.ips)).toBe(true);
  });
  it('matches CIDR', () => {
    expect(matchIp('10.1.2.3', scope.ips)).toBe(true);
  });
  it('rejects outside CIDR', () => {
    expect(matchIp('172.16.0.1', scope.ips)).toBe(false);
  });
});

describe('matchUrlPrefix', () => {
  it('matches prefix with port', () => {
    expect(matchUrlPrefix('https://api.specific.com/v1/users', scope.urlPrefixes)).toBe(true);
  });
  it('rejects different path', () => {
    expect(matchUrlPrefix('https://api.specific.com/v2/users', scope.urlPrefixes)).toBe(false);
  });
});

describe('checkScope', () => {
  it('allows in-scope domain', () => {
    const result = checkScope('https://api.example.com/users', scope);
    expect(result.allowed).toBe(true);
  });
  it('allows in-scope IP', () => {
    const result = checkScope('http://10.0.0.1/api', scope);
    expect(result.allowed).toBe(true);
  });
  it('allows in-scope URL prefix', () => {
    const result = checkScope('https://api.specific.com/v1/users', scope);
    expect(result.allowed).toBe(true);
  });
  it('rejects out-of-scope domain', () => {
    const result = checkScope('https://evil.com/steal', scope);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('not in authorized scope');
    }
  });
  it('rejects excluded host', () => {
    const result = checkScope('https://admin.example.com/delete', scope);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('exclusion');
    }
  });
  it('rejects domain with out-of-scope resolved IP when both scopes exist', () => {
    // When both domainSuffixes and ips are specified, domain match + IP mismatch = rejected
    const result = checkScope('https://api.example.com/data', scope, ['172.16.0.1']);
    expect(result.allowed).toBe(false);
  });
  it('suggests upgrade for out-of-scope', () => {
    const result = checkScope('https://new-target.com/api', scope);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.suggestedUpgrade?.url_prefix).toBe('https://new-target.com');
    }
  });
});

describe('classifyRisk', () => {
  it('internet tools are A1', () => {
    expect(classifyRisk('web.search')).toBe('A1');
    expect(classifyRisk('web.fetch')).toBe('A1');
  });
  it('http is A1', () => {
    expect(classifyRisk('http.request')).toBe('A1');
  });
  it('bash is A2', () => {
    expect(classifyRisk('bash')).toBe('A2');
  });
});

describe('systemBlock', () => {
  it('formats correctly', () => {
    const block = systemBlock('Not in scope');
    expect(block.ok).toBe(false);
    expect(block.blocked_by).toBe('platform');
    expect(block.reason).toContain('SRC-Agent 平台管控');
    expect(block.reason).toContain('Not in scope');
  });
});

describe('markUntrusted', () => {
  it('wraps content', () => {
    const result = markUntrusted('<script>alert(1)</script>', 'web_fetch');
    expect(result).toContain('<untrusted origin="web_fetch">');
    expect(result).toContain('<script>alert(1)</script>');
    expect(result).toContain('</untrusted>');
  });
});

describe('matchUrlPrefix structural matching', () => {
  it('does not match lookalike host that only shares a string prefix', () => {
    expect(matchUrlPrefix('http://host.docker.internal.evil.com:64280/x', [
      { prefix: 'http://host.docker.internal:64280' },
    ])).toBe(false);
  });
  it('matches exact root URL without trailing slash', () => {
    expect(matchUrlPrefix('http://host.docker.internal:64280', [
      { prefix: 'http://host.docker.internal:64280' },
    ])).toBe(true);
  });
  it('matches subpath under configured target', () => {
    expect(matchUrlPrefix('http://target.test:8080/app/login', [
      { prefix: 'http://target.test:8080/app' },
    ])).toBe(true);
  });
  it('rejects sibling path', () => {
    expect(matchUrlPrefix('http://target.test:8080/application', [
      { prefix: 'http://target.test:8080/app' },
    ])).toBe(false);
  });
});

describe('buildScopeForTarget', () => {
  it('derives a URL-prefix scope from a URL target', () => {
    const derived = buildScopeForTarget({ type: 'url', value: 'http://host.docker.internal:64280' });
    expect(derived.urlPrefixes).toEqual([{ prefix: 'http://host.docker.internal:64280', ports: [64280] }]);
    expect(derived.domainSuffixes).toEqual([]);
    expect(checkScope('http://host.docker.internal:64280/api/v2/health', derived).allowed).toBe(true);
    expect(checkScope('http://host.docker.internal:64280.evil.com/', derived).allowed).toBe(false);
    expect(checkScope('https://host.docker.internal:64280/', derived).allowed).toBe(false);
  });

  it('derives an IP grant from an IP target with port', () => {
    const derived = buildScopeForTarget({ type: 'ip', value: '10.1.2.3:8443' });
    expect(derived.ips).toEqual(['10.1.2.3']);
    expect(checkScope('http://10.1.2.3:8443/x', derived).allowed).toBe(true);
    expect(checkScope('http://10.1.2.4:8443/x', derived).allowed).toBe(false);
  });

  it('derives a domain grant from a domain target', () => {
    const derived = buildScopeForTarget({ type: 'domain', value: 'lab.example.test' });
    expect(derived.domainSuffixes).toEqual(['lab.example.test']);
    expect(checkScope('https://api.lab.example.test/', derived).allowed).toBe(true);
    expect(checkScope('https://example.test/', derived).allowed).toBe(false);
  });

  it('merges explicit scope extras (local lab resolved address)', () => {
    const derived = buildScopeForTarget(
      { type: 'url', value: 'http://host.docker.internal:64280' },
      { ips: ['0.250.250.254/32'] },
    );
    expect(derived.ips).toEqual(['0.250.250.254/32']);
  });
});

describe('allowAll attachment scopes', () => {
  it('allows arbitrary audited network egress when the grant explicitly says allowAll', () => {
    const scope: GrantScope = {
      domainSuffixes: [],
      ips: [],
      urlPrefixes: [],
      exclude: [],
      allowAll: true,
    };
    expect(checkScope('http://127.0.0.1:65280/api/v2/profile', scope).allowed).toBe(true);
    expect(checkScope('https://example.com/', scope).allowed).toBe(true);
  });

  it('derives allowAll for an attachment-only target', () => {
    const derived = buildScopeForTarget({ type: 'file', value: 'attachments' });
    expect(derived.allowAll).toBe(true);
  });
});
