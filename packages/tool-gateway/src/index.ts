import type { GrantScope, MissionTarget } from '@src-agent/contracts';

// ── URL / IP matching ────────────────────────────────────────

export function matchDomain(host: string, suffixes: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return suffixes.some(s => {
    const suffix = s.toLowerCase().replace(/\.$/, '');
    return h === suffix || h.endsWith('.' + suffix);
  });
}

export function isExcluded(host: string, exclude: string[]): boolean {
  return matchDomain(host, exclude);
}

export function matchIp(ip: string, cidrs: string[]): boolean {
  return cidrs.some(cidr => {
    if (cidr.includes('/')) {
      return ipInCidr(ip, cidr);
    }
    return ip === cidr;
  });
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [network, bits] = cidr.split('/');
  const prefix = parseInt(bits, 10);
  const ipNum = ipToNum(ip);
  const netNum = ipToNum(network);
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  return (ipNum & mask) === (netNum & mask);
}

function ipToNum(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function matchUrlPrefix(url: string, prefixes: { prefix: string; ports?: number[] }[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const parsedPort = effectivePort(parsed);
  return prefixes.some(entry => {
    let prefix: URL;
    try {
      prefix = new URL(entry.prefix);
    } catch {
      return false;
    }
    if (parsed.protocol !== prefix.protocol) return false;
    if (parsed.hostname !== prefix.hostname) return false;
    if (parsedPort !== effectivePort(prefix)) return false;
    if (entry.ports && entry.ports.length > 0 && !entry.ports.includes(parsedPort)) return false;
    const prefixPath = prefix.pathname;
    if (prefixPath === '/' || prefixPath === '') return true;
    if (parsed.pathname === prefixPath) return true;
    return parsed.pathname.startsWith(prefixPath.endsWith('/') ? prefixPath : `${prefixPath}/`);
  });
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

// ── Scope check result ───────────────────────────────────────

export type ScopeVerdict =
  | { allowed: true }
  | { allowed: false; reason: string; suggestedUpgrade?: { url_prefix?: string; ip?: string } };

export function checkScope(
  url: string,
  scope: GrantScope,
  resolvedIps?: string[],
): ScopeVerdict {
  if (scope.allowAll) return { allowed: true };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'Invalid URL' };
  }

  const host = parsed.hostname;

  // Check exclude list first
  if (isExcluded(host, scope.exclude)) {
    return { allowed: false, reason: `Host "${host}" is in exclusion list` };
  }

  // Check domain suffixes
  if (matchDomain(host, scope.domainSuffixes)) {
    // If domain matches, also check resolved IPs if provided
    if (resolvedIps && resolvedIps.length > 0 && scope.ips.length > 0) {
      const ipOk = resolvedIps.some(ip => matchIp(ip, scope.ips));
      if (!ipOk) {
        return {
          allowed: false,
          reason: `Domain "${host}" matches scope but resolved IPs [${resolvedIps.join(', ')}] are outside authorized IP ranges`,
          suggestedUpgrade: { ip: resolvedIps[0] },
        };
      }
    }
    return { allowed: true };
  }

  // Check IP ranges
  if (scope.ips.length > 0) {
    try {
      // Host might be an IP itself
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && matchIp(host, scope.ips)) {
        return { allowed: true };
      }
      // Or check resolved IPs
      if (resolvedIps && resolvedIps.some(ip => matchIp(ip, scope.ips))) {
        return { allowed: true };
      }
    } catch { /* ignore */ }
  }

  // Check URL prefixes
  if (matchUrlPrefix(url, scope.urlPrefixes)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Target "${host}" is not in authorized scope. Domains: [${scope.domainSuffixes.join(', ')}], IPs: [${scope.ips.join(', ')}], Prefixes: [${scope.urlPrefixes.map(p => p.prefix).join(', ')}]`,
    suggestedUpgrade: { url_prefix: `${parsed.protocol}//${parsed.host}` },
  };
}

// ── Risk classification ──────────────────────────────────────

import type { RiskLevel } from '@src-agent/contracts';
import { InternetToolSet } from '@src-agent/contracts';
export { InternetToolSet } from '@src-agent/contracts';

export function classifyRisk(toolName: string): RiskLevel {
  if (InternetToolSet.has(toolName)) return 'A1';
  if (toolName === 'http.request' || toolName === 'web_fetch') return 'A1';
  if (toolName === 'bash' || toolName === 'cmd.exec') return 'A2';
  if (toolName === 'read' || toolName === 'write') return 'A2';
  if (toolName === 'browser') return 'A2';
  return 'A2'; // default to A2 for unknown tools
}

// ── System block message ─────────────────────────────────────

export function systemBlock(reason: string, approvalRequired = false, approvalId?: string) {
  return {
    ok: false as const,
    blocked_by: 'platform' as const,
    reason: `【SRC-Agent 平台管控·非目标防御】${reason}`,
    approval_required: approvalRequired,
    approval_id: approvalId,
  };
}

// ── Untrusted content wrapper ────────────────────────────────

export function markUntrusted(content: string, source: string): string {
  return `<untrusted origin="${source}">\n${content}\n</untrusted>`;
}

// ── Mission target → grant scope ────────────────────────────

export interface ScopeExtras {
  domainSuffixes?: string[];
  ips?: string[];
  urlPrefixes?: string[];
}

/**
 * Derives the narrowest useful grant scope for a mission target. A URL target
 * is constrained by scheme+authority+path prefix; an IP or domain target grants
 * only that host. Extra explicit grants (for example the resolved address of a
 * local lab host) can be added by the mission author.
 */
export function buildScopeForTarget(target: MissionTarget, extras: ScopeExtras = {}): GrantScope {
  const domainSuffixes = new Set((extras.domainSuffixes ?? []).map(value => value.trim()).filter(Boolean));
  const ips = new Set((extras.ips ?? []).map(value => value.trim()).filter(Boolean));
  const urlPrefixes = new Map<string, { prefix: string; ports?: number[] }>();
  for (const prefix of extras.urlPrefixes ?? []) {
    const trimmed = prefix.trim();
    if (trimmed) urlPrefixes.set(trimmed, { prefix: trimmed });
  }

  if (target.type === 'file') {
    return {
      domainSuffixes: [...domainSuffixes],
      ips: [...ips],
      urlPrefixes: [...urlPrefixes.values()],
      exclude: [],
      allowAll: true,
    };
  }

  const value = target.value.trim();
  if (!value) throw new Error('target value is empty');

  if (target.type === 'url') {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`unsupported target scheme ${url.protocol}`);
    }
    if (url.username || url.password) throw new Error('target URL must not contain userinfo');
    if (isIpLiteral(url.hostname)) ips.add(url.hostname);
    const prefix = `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
    urlPrefixes.set(prefix, { prefix, ports: [Number(url.port) || (url.protocol === 'https:' ? 443 : 80)] });
    return {
      domainSuffixes: [...domainSuffixes],
      ips: [...ips],
      urlPrefixes: [...urlPrefixes.values()],
      exclude: [],
      allowAll: false,
    };
  }

  const host = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '');
  const hostname = splitHostPort(host).hostname;
  if (!hostname) throw new Error('target host is empty');
  if (isIpLiteral(hostname)) ips.add(hostname);
  else domainSuffixes.add(hostname);
  return {
    domainSuffixes: [...domainSuffixes],
    ips: [...ips],
    urlPrefixes: [...urlPrefixes.values()],
    exclude: [],
    allowAll: false,
  };
}

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
}

function splitHostPort(authority: string): { hostname: string; port?: number } {
  const match = authority.match(/^\[([^\]]+)\](?::(\d+))?$/) ?? authority.match(/^([^:]+)(?::(\d+))?$/);
  if (!match) return { hostname: authority };
  return { hostname: match[1], port: match[2] ? Number(match[2]) : undefined };
}
