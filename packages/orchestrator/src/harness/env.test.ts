import { describe, expect, it } from 'vitest';
import { sanitizeHarnessEnv } from './runner.js';

describe('Harness child environment isolation', () => {
  it('drops database and operator credentials but keeps the mission read token', () => {
    const env = sanitizeHarnessEnv({
      PG_HOST: 'postgres',
      PG_PASSWORD: 'secret',
      PGPASSWORD: 'secret',
      API_AUTH_TOKEN: 'admin',
      API_ADMIN_TOKEN: 'admin',
      SRC_AGENT_MISSION_API_TOKEN: 'read-only',
      LLM_API_KEY: 'model-key',
      PATH: '/usr/bin',
    } as NodeJS.ProcessEnv);
    expect(env.PG_HOST).toBeUndefined();
    expect(env.PG_PASSWORD).toBeUndefined();
    expect(env.PGPASSWORD).toBeUndefined();
    expect(env.API_AUTH_TOKEN).toBeUndefined();
    expect(env.API_ADMIN_TOKEN).toBeUndefined();
    expect(env.SRC_AGENT_MISSION_API_TOKEN).toBe('read-only');
    expect(env.LLM_API_KEY).toBe('model-key');
    expect(env.PATH).toBe('/usr/bin');
  });
});
