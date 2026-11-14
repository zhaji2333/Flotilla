// Rotating browser User-Agent pool for target traffic. The worker should not
// advertise itself with a fixed product token: each request picks a realistic
// desktop/mobile UA so the target sees ordinary browser traffic. Tests can pin
// SRC_AGENT_UA_MODE=fixed + SRC_AGENT_UA_FIXED.

export const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/133.0',
];

let lastIndex = -1;

/** Picks a random browser UA, avoiding repeating the immediately previous one. */
export function randomUserAgent(random: () => number = Math.random): string {
  let index = Math.floor(random() * USER_AGENTS.length);
  if (index >= USER_AGENTS.length) index = USER_AGENTS.length - 1;
  if (index === lastIndex) index = (index + 1) % USER_AGENTS.length;
  lastIndex = index;
  return USER_AGENTS[index] ?? USER_AGENTS[0]!;
}

/** Resolves the UA for one request from env (random by default). */
export function resolveUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  const mode = (env.SRC_AGENT_UA_MODE ?? 'random').trim().toLowerCase();
  const fixed = (env.SRC_AGENT_UA_FIXED ?? '').trim();
  if (mode === 'fixed' && fixed) return fixed;
  return randomUserAgent();
}
