// ── web_search DLP (v1.0.2, ADR-0054) ──────────────────────
// Mission-level policy: disabled blocks search, limited strips the target
// identity/secrets before the query leaves the platform, allowed passes it
// through unchanged (still audited). Results are always untrusted data.

export type SearchPolicy = 'disabled' | 'limited' | 'allowed';

export interface SearchPolicyOutcome {
  policy: SearchPolicy;
  ok: boolean;
  query: string;
  reason: string | null;
  masked: string[];
}

const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'secret', pattern: /(?:sk|rk|pk)[_-][A-Za-z0-9_]{16,}/g },
  { label: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: 'github_token', pattern: /gh[pous]_[A-Za-z0-9]{20,}/g },
  { label: 'aws_key', pattern: /AKIA[0-9A-Z]{16}/g },
  { label: 'bearer', pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  { label: 'password', pattern: /(?:password|passwd|pwd)\s*[=:]\s*\S+/gi },
];

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

function targetsFrom(value: string | null | undefined): string[] {
  if (!value) return [];
  const raw = value.trim();
  const values = new Set<string>([raw]);
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    if (url.hostname) {
      values.add(url.hostname);
      values.add(url.host);
      const labels = url.hostname.split('.');
      if (labels.length >= 2) values.add(labels.slice(-2).join('.'));
    }
  } catch {
    const host = raw.replace(/^[a-z]+:\/\//i, '').split(/[/:?#]/)[0];
    if (host) values.add(host);
  }
  return [...values].filter(item => item.length >= 4 && item !== 'http' && item !== 'https');
}

/** Mask the authorized target and obvious secrets; limited mode never leaks them. */
export function sanitizeSearchQuery(
  rawQuery: string,
  targetValue: string | null | undefined,
  policy: SearchPolicy = 'limited',
): SearchPolicyOutcome {
  const parsedPolicy: SearchPolicy = policy === 'disabled' || policy === 'allowed' ? policy : 'limited';
  const original = rawQuery.trim().slice(0, 128);
  if (parsedPolicy === 'disabled') {
    return { policy: parsedPolicy, ok: false, query: '', reason: 'search disabled by mission policy', masked: [] };
  }
  if (parsedPolicy === 'allowed') {
    return { policy: parsedPolicy, ok: true, query: original, reason: null, masked: [] };
  }
  let sanitized = original;
  const masked: string[] = [];
  for (const target of targetsFrom(targetValue)) {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'gi');
    if (pattern.test(sanitized)) {
      sanitized = sanitized.replace(pattern, '[redacted-target]');
      masked.push('target');
    }
  }
  if (IPV4.test(sanitized)) {
    sanitized = sanitized.replace(IPV4, '[redacted-ip]');
    masked.push('ip');
  }
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(sanitized)) {
      sanitized = sanitized.replace(pattern, '[redacted-secret]');
      masked.push(label);
    }
    pattern.lastIndex = 0;
  }
  sanitized = sanitized.replace(/\s+/g, ' ').trim().slice(0, 128);
  const meaningful = sanitized.replace(/\[redacted-[a-z-]+\]/gi, '').replace(/[^A-Za-z0-9]/g, '');
  if (meaningful.length < 3) {
    return { policy: parsedPolicy, ok: false, query: sanitized, reason: 'query is only target/secret material after masking', masked };
  }
  return { policy: parsedPolicy, ok: true, query: sanitized, reason: null, masked };
}
