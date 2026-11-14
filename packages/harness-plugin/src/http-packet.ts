// Builds the raw request text stored as evidence. It always contains an
// explicit request line and Host header so the report shows which real host was
// contacted (the previous format printed a full URL and could omit Host).

export function buildRawRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
): string {
  const parsed = new URL(url);
  const path = `${parsed.pathname || '/'}${parsed.search}`;
  const lines = [`${method.toUpperCase()} ${path} HTTP/1.1`, `Host: ${parsed.host}`];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'host') continue;
    lines.push(`${key}: ${value}`);
  }
  if (body !== undefined) {
    lines.push('', body);
  }
  return lines.join('\n');
}
