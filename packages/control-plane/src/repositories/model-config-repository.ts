import { z } from 'zod';
import type { Pool } from 'pg';
import { getPool } from '../db';

// ── P3-B2 model configuration ──────────────────────────────
// UI-editable model endpoint profiles. API keys are stored in PLAINTEXT by
// explicit user decision (ADR-0011); permission control is enforced at the API
// layer (admin token) and every reveal is audited. Normal list/detail responses
// only expose a masked key so the console can show "configured" state.

const MODEL_ROLES = ['worker', 'planner', 'scout', 'executor', 'specialist', 'guard'] as const;
const MODEL_TIERS = ['default', 'fast', 'strong'] as const;

function httpUrlSchema(name: string): z.ZodString {
  return z.string().min(1).max(500).superRefine((value, context) => {
    let parsed: URL;
    try {
      parsed = new URL(value.trim());
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${name} must be an absolute URL` });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${name} must be http(s)` });
    }
    if (!parsed.hostname) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${name} must include a hostname` });
    }
  });
}

export const ModelConfigWriteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  baseUrl: httpUrlSchema('baseUrl'),
  apiKey: z.string().min(1).max(8_000),
  modelName: z.string().trim().min(1).max(200),
  apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).max(120).default('SRC_AGENT_MODEL_API_KEY'),
  contextWindow: z.number().int().positive().max(10_000_000).default(1_000_000),
  maxOutputTokens: z.number().int().positive().max(2_000_000).default(393_216),
  reasoningEffort: z.enum(['low', 'high', 'max']).nullish(),
  compat: z.record(z.string(), z.unknown()).default({}),
  role: z.enum(MODEL_ROLES).nullish(),
  tier: z.enum(MODEL_TIERS).nullish(),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
}).strict();

export const ModelConfigUpdateSchema = ModelConfigWriteSchema.partial().strict();

export type ModelConfigWrite = z.infer<typeof ModelConfigWriteSchema>;
export type ModelConfigUpdate = z.infer<typeof ModelConfigUpdateSchema>;

export interface ModelConfigRow {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  modelName: string;
  apiKeyEnv: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoningEffort: string | null;
  compat: Record<string, unknown>;
  role: string | null;
  tier: string | null;
  enabled: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** API/list projection: never contains the plaintext key. */
export interface PublicModelConfig extends Omit<ModelConfigRow, 'apiKey'> {
  apiKeySet: boolean;
  apiKeyMasked: string;
}

/** Internal projection used by Worker/Planner; contains the plaintext key. */
export interface ResolvedModelConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  modelName: string;
  apiKeyEnv: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoningEffort: 'low' | 'high' | 'max' | null;
  compat: Record<string, unknown>;
  role: string | null;
  tier: string | null;
}

export interface ModelConfigAuditRow {
  id: number;
  configId: string | null;
  configName: string;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface ModelConfigReveal {
  id: string;
  name: string;
  apiKey: string;
  updatedAt: string;
}

function rowToConfig(row: Record<string, unknown>): ModelConfigRow {
  return {
    id: String(row.id),
    name: String(row.name),
    baseUrl: String(row.base_url),
    apiKey: String(row.api_key),
    modelName: String(row.model_name),
    apiKeyEnv: String(row.api_key_env),
    contextWindow: Number(row.context_window),
    maxOutputTokens: Number(row.max_output_tokens),
    reasoningEffort: row.reasoning_effort ? String(row.reasoning_effort) : null,
    compat: (row.compat ?? {}) as Record<string, unknown>,
    role: row.role ? String(row.role) : null,
    tier: row.tier ? String(row.tier) : null,
    enabled: Boolean(row.enabled),
    isDefault: Boolean(row.is_default),
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

export function maskModelApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return '••••';
  return `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}`;
}

function toPublic(config: ModelConfigRow): PublicModelConfig {
  const { apiKey, ...rest } = config;
  return { ...rest, apiKeySet: apiKey.length > 0, apiKeyMasked: maskModelApiKey(apiKey) };
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

async function audit(
  client: import('pg').PoolClient,
  input: { configId: string | null; configName: string; actor: string; action: string; detail?: Record<string, unknown> },
): Promise<void> {
  await client.query(
    `INSERT INTO model_config_audit (config_id, config_name, actor, action, detail)
     VALUES ($1,$2,$3,$4,$5)`,
    [input.configId, input.configName.slice(0, 120), input.actor.slice(0, 120), input.action, JSON.stringify(input.detail ?? {})],
  );
}

export async function getModelConfigResolved(id: string): Promise<ResolvedModelConfig | null> {
  const result = await getPool().query(`SELECT * FROM model_configs WHERE id = $1`, [id]);
  if (result.rowCount === 0) return null;
  const config = rowToConfig(result.rows[0]);
  return {
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    modelName: config.modelName,
    apiKeyEnv: config.apiKeyEnv,
    contextWindow: config.contextWindow,
    maxOutputTokens: config.maxOutputTokens,
    reasoningEffort: (config.reasoningEffort as ResolvedModelConfig['reasoningEffort']) ?? null,
    compat: config.compat,
    role: config.role,
    tier: config.tier,
  };
}

export async function listModelConfigs(): Promise<PublicModelConfig[]> {
  const result = await getPool().query(`SELECT * FROM model_configs ORDER BY is_default DESC, updated_at DESC`);
  return result.rows.map(row => toPublic(rowToConfig(row)));
}

export async function getModelConfig(id: string): Promise<PublicModelConfig | null> {
  const result = await getPool().query(`SELECT * FROM model_configs WHERE id = $1`, [id]);
  return result.rows[0] ? toPublic(rowToConfig(result.rows[0])) : null;
}

export async function listModelConfigAudit(limit = 100): Promise<ModelConfigAuditRow[]> {
  const result = await getPool().query(
    `SELECT id, config_id, config_name, actor, action, detail, created_at
     FROM model_config_audit ORDER BY id DESC LIMIT $1`,
    [Math.max(1, Math.min(500, limit))],
  );
  return result.rows.map(row => ({
    id: Number(row.id),
    configId: row.config_id ? String(row.config_id) : null,
    configName: String(row.config_name),
    actor: String(row.actor),
    action: String(row.action),
    detail: (row.detail ?? {}) as Record<string, unknown>,
    createdAt: new Date(row.created_at as string).toISOString(),
  }));
}

export async function createModelConfig(input: ModelConfigWrite, actor = 'api-admin'): Promise<PublicModelConfig> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(`SELECT count(*)::int AS total FROM model_configs`);
    const makeDefault = input.isDefault || Number(existing.rows[0]?.total ?? 0) === 0;
    if (makeDefault) {
      await client.query(`UPDATE model_configs SET is_default = false, updated_at = now() WHERE is_default`);
    }
    const inserted = await client.query(
      `INSERT INTO model_configs
         (name, base_url, api_key, model_name, api_key_env, context_window, max_output_tokens,
          reasoning_effort, compat, role, tier, enabled, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        input.name,
        normalizeBaseUrl(input.baseUrl),
        input.apiKey,
        input.modelName,
        input.apiKeyEnv,
        input.contextWindow,
        input.maxOutputTokens,
        input.reasoningEffort ?? null,
        JSON.stringify(input.compat),
        input.role ?? null,
        input.tier ?? null,
        input.enabled,
        makeDefault,
      ],
    );
    const config = rowToConfig(inserted.rows[0]);
    await audit(client, {
      configId: config.id,
      configName: config.name,
      actor,
      action: 'create',
      detail: { modelName: config.modelName, baseUrl: config.baseUrl, role: config.role, tier: config.tier, isDefault: config.isDefault },
    });
    await client.query('COMMIT');
    return toPublic(config);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateModelConfig(id: string, input: ModelConfigUpdate, actor = 'api-admin'): Promise<PublicModelConfig | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(`SELECT * FROM model_configs WHERE id = $1 FOR UPDATE`, [id]);
    if (current.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    if (input.isDefault === true) {
      await client.query(`UPDATE model_configs SET is_default = false, updated_at = now() WHERE is_default AND id <> $1`, [id]);
    }
    const fields: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };
    if (input.name !== undefined) push('name', input.name);
    if (input.baseUrl !== undefined) push('base_url', normalizeBaseUrl(input.baseUrl));
    if (input.apiKey !== undefined) push('api_key', input.apiKey);
    if (input.modelName !== undefined) push('model_name', input.modelName);
    if (input.apiKeyEnv !== undefined) push('api_key_env', input.apiKeyEnv);
    if (input.contextWindow !== undefined) push('context_window', input.contextWindow);
    if (input.maxOutputTokens !== undefined) push('max_output_tokens', input.maxOutputTokens);
    if (input.reasoningEffort !== undefined) push('reasoning_effort', input.reasoningEffort);
    if (input.compat !== undefined) push('compat', JSON.stringify(input.compat));
    if (input.role !== undefined) push('role', input.role);
    if (input.tier !== undefined) push('tier', input.tier);
    if (input.enabled !== undefined) push('enabled', input.enabled);
    if (input.isDefault !== undefined) push('is_default', input.isDefault);
    if (fields.length > 0) {
      values.push(id);
      await client.query(
        `UPDATE model_configs SET ${fields.join(', ')}, updated_at = now() WHERE id = $${values.length}`,
        values,
      );
    }
    const updated = await client.query(`SELECT * FROM model_configs WHERE id = $1`, [id]);
    const config = rowToConfig(updated.rows[0]);
    await audit(client, {
      configId: config.id,
      configName: config.name,
      actor,
      action: 'update',
      detail: { changed: Object.keys(input).filter(key => key !== 'apiKey'), apiKeyChanged: input.apiKey !== undefined },
    });
    await client.query('COMMIT');
    return toPublic(config);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteModelConfig(id: string, actor = 'api-admin'): Promise<boolean> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(`SELECT * FROM model_configs WHERE id = $1 FOR UPDATE`, [id]);
    if (current.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    const config = rowToConfig(current.rows[0]);
    await client.query(`DELETE FROM model_configs WHERE id = $1`, [id]);
    await audit(client, {
      configId: config.id,
      configName: config.name,
      actor,
      action: 'delete',
      detail: { modelName: config.modelName, wasDefault: config.isDefault },
    });
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Admin-only: returns the plaintext key and records an audited reveal. */
export async function revealModelConfig(id: string, actor = 'api-admin'): Promise<ModelConfigReveal | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(`SELECT * FROM model_configs WHERE id = $1`, [id]);
    if (current.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const config = rowToConfig(current.rows[0]);
    await audit(client, {
      configId: config.id,
      configName: config.name,
      actor,
      action: 'reveal',
      detail: { modelName: config.modelName },
    });
    await client.query('COMMIT');
    return { id: config.id, name: config.name, apiKey: config.apiKey, updatedAt: config.updatedAt };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Internal (Worker/Planner) lookup: enabled config matching the role, falling
 * back to the default/active config. Returns plaintext key; callers must not
 * log this object.
 */
export async function getActiveModelConfig(
  pool: Pool | undefined,
  role?: 'worker' | 'planner' | 'scout' | 'executor' | 'specialist' | 'guard',
): Promise<ResolvedModelConfig | null> {
  const db = pool ?? getPool();
  // Resolution order: exact role -> explicitly marked default -> none.
  // Never fall back to an arbitrary role-bound config: that would make a
  // planner/guard silently inherit an unrelated worker model.
  let result = role
    ? await db.query(
        `SELECT * FROM model_configs WHERE enabled AND role = $1
         ORDER BY is_default DESC, updated_at DESC LIMIT 1`,
        [role],
      )
    : { rows: [], rowCount: 0 } as { rows: Record<string, unknown>[]; rowCount: number };
  if ((result.rowCount ?? 0) === 0) {
    result = await db.query(
      `SELECT * FROM model_configs WHERE enabled AND is_default
       ORDER BY updated_at DESC LIMIT 1`,
    );
  }
  if ((result.rowCount ?? 0) === 0) return null;
  const row = result.rows[0]!;
  const config = rowToConfig(row);
  return {
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    modelName: config.modelName,
    apiKeyEnv: config.apiKeyEnv,
    contextWindow: config.contextWindow,
    maxOutputTokens: config.maxOutputTokens,
    reasoningEffort: (config.reasoningEffort as ResolvedModelConfig['reasoningEffort']) ?? null,
    compat: config.compat,
    role: config.role,
    tier: config.tier,
  };
}
