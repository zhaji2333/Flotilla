/** Extract high-signal URL/API candidates from JS chunks or source maps. */
export function extractCandidates(text: string, limit = 200): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s"'`<>\\]+/g)) {
    found.add(match[0].replace(/[),.;]+$/, ''));
  }
  for (const match of text.matchAll(/(?:^|["'`\s])((?:\/api|\/v\d+|\/rest|\/graphql|\/internal|\/admin)[A-Za-z0-9_./?&=%:-]{2,})/g)) {
    found.add(match[1]!);
  }
  return [...found].slice(0, limit);
}

export function isJavaScriptResource(url: string, resourceType: string): boolean {
  return resourceType === 'script' || /\.m?js(?:$|[?#])/i.test(url) || /\.js\.map(?:$|[?#])/i.test(url);
}

export function isSourceMapResource(url: string): boolean {
  return /\.map(?:$|[?#])/i.test(url);
}

export function sourceMapDirective(body: string): string | null {
  const match = body.match(/[#@]\s*sourceMappingURL=([^\s*]+)/);
  return match?.[1] ?? null;
}

/** Decode an inline base64 source map when a chunk embeds one. */
export function inlineSourceMap(body: string): string | null {
  const directive = sourceMapDirective(body);
  const match = directive?.match(/^data:application\/json(?:;charset=[^;]+)?;base64,(.+)$/);
  if (!match) return null;
  try {
    return Buffer.from(match[1]!, 'base64').toString('utf8');
  } catch {
    return null;
  }
}
