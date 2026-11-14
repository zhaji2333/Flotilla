import { createHash } from 'node:crypto';

// ── Request fingerprints ────────────────────────────────────
// Shared by the controller (writes the index) and the Worker plugin (warns on
// a repeat). Only hashes and a normalized URL leave this module.

export interface RequestFingerprintInput {
  method: string;
  normalizedUrl: string;
  urlHash: string;
  bodyHash: string;
  authHash: string;
  statusCode?: number | null;
  trafficRef?: string | null;
}

export interface RequestIndexEntry extends Omit<RequestFingerprintInput, 'statusCode' | 'trafficRef'> {
  statusCode?: number | null;
  taskId: string;
  trafficRef?: string | null;
  lastSeenAt: string;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeRequestUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = '';
    return url.toString();
  } catch {
    return raw.trim().slice(0, 2_000);
  }
}

function headerValue(headers: unknown, name: string): string {
  if (!headers || typeof headers !== 'object') return '';
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === name.toLowerCase()) return String(value ?? '');
  }
  return '';
}

export function requestAuthHash(headers: unknown): string {
  const auth = headerValue(headers, 'authorization');
  const cookie = headerValue(headers, 'cookie');
  return sha256(`${auth}\u0000${cookie}`);
}

export function requestBodyHash(body: unknown): string {
  if (body === undefined || body === null) return sha256('');
  return sha256(typeof body === 'string' ? body : JSON.stringify(body));
}

export function fingerprintRequest(input: {
  method: string;
  url: string;
  body?: unknown;
  headers?: unknown;
  statusCode?: number | null;
  trafficRef?: string | null;
}): RequestFingerprintInput {
  const normalizedUrl = normalizeRequestUrl(input.url);
  return {
    method: String(input.method || 'GET').toUpperCase(),
    normalizedUrl,
    urlHash: sha256(normalizedUrl),
    bodyHash: requestBodyHash(input.body),
    authHash: requestAuthHash(input.headers),
    ...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
    ...(input.trafficRef === undefined ? {} : { trafficRef: input.trafficRef }),
  };
}
