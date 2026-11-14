/** Browser navigation is intentionally http(s)-only. */
export function assertNavigableUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new Error('url is required');
  if (raw.length > 8_192) throw new Error('url is too long');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('url is not a valid absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported URL scheme: ${url.protocol}`);
  }
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed');
  return url;
}

export function isSafeSelector(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1_000;
}
