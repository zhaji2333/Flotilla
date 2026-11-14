import { z } from 'zod';
import { GrantScopeSchema, type GrantScope } from '@src-agent/contracts';
import { buildScopeForTarget } from '@src-agent/tool-gateway';
import { getPool } from '../db';

// ── P2 Grant versioning & scope-upgrade approvals ───────────
// A scope denial is never silently bypassed: a human asks for an upgrade, the
// approval center decides, and only then does the mission move to a new
// immutable grant version. Open tasks are rebound in the same transaction.

export const ScopeUpgradeRequestSchema = z.object({
  url: z.string().min(1).max(2_000).optional(),
  domainSuffixes: z.array(z.string().min(1)).optional(),
  ips: z.array(z.string().min(1)).optional(),
  urlPrefixes: z.array(z.string().min(1)).optional(),
  reason: z.string().max(1_000).optional(),
}).strict().refine(
  value => Boolean(value.url) || (value.domainSuffixes?.length ?? 0) + (value.ips?.length ?? 0) + (value.urlPrefixes?.length ?? 0) > 0,
  { message: 'url 或 domainSuffixes/ips/urlPrefixes 至少提供一个' },
);

export type ScopeUpgradeRequest = z.infer<typeof ScopeUpgradeRequestSchema>;

export interface ScopeUpgradeApproval {
  approvalId: string;
  missionId: string;
  scopeExtras: Partial<GrantScope>;
}

function extrasOf(input: ScopeUpgradeRequest): Partial<GrantScope> {
  if (input.url) {
    const derived = buildScopeForTarget({ type: 'url', value: input.url });
    return { domainSuffixes: derived.domainSuffixes, ips: derived.ips, urlPrefixes: derived.urlPrefixes };
  }
  return {
    ...(input.domainSuffixes ? { domainSuffixes: input.domainSuffixes } : {}),
    ...(input.ips ? { ips: input.ips } : {}),
    ...(input.urlPrefixes ? { urlPrefixes: input.urlPrefixes.map(prefix => ({ prefix })) } : {}),
  };
}

export async function requestScopeUpgrade(missionId: string, input: ScopeUpgradeRequest): Promise<ScopeUpgradeApproval> {
  const scopeExtras = extrasOf(input);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const mission = await client.query(`SELECT id FROM missions WHERE id = $1 FOR UPDATE`, [missionId]);
    if (mission.rowCount === 0) throw new Error(`mission ${missionId} not found`);
    const inserted = await client.query(
      `INSERT INTO approvals (mission_id, type, status, payload) VALUES ($1, 'scope_upgrade', 'pending', $2) RETURNING id`,
      [missionId, JSON.stringify({ scopeExtras, reason: input.reason ?? null })],
    );
    const approvalId = String(inserted.rows[0].id);
    await client.query(
      `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,'approval.requested',$2,$3)`,
      [missionId, approvalId, JSON.stringify({ type: 'scope_upgrade', scopeExtras })],
    );
    await client.query('COMMIT');
    return { approvalId, missionId, scopeExtras };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function mergeScope(current: GrantScope, extras: Partial<GrantScope>): GrantScope {
  const currentPrefixes = current.urlPrefixes ?? [];
  const extraPrefixes = extras.urlPrefixes ?? [];
  const mergedPrefixes = [...currentPrefixes];
  for (const item of extraPrefixes) {
    const existing = mergedPrefixes.find(prefix => prefix.prefix === item.prefix);
    if (!existing) mergedPrefixes.push(item);
    else if (item.ports && item.ports.length > 0) {
      existing.ports = unique([...(existing.ports ?? []), ...item.ports]);
    }
  }
  return GrantScopeSchema.parse({
    domainSuffixes: unique([...(current.domainSuffixes ?? []), ...(extras.domainSuffixes ?? [])]),
    ips: unique([...(current.ips ?? []), ...(extras.ips ?? [])]),
    urlPrefixes: mergedPrefixes,
    exclude: current.exclude ?? [],
  });
}

export interface AppliedScopeUpgrade {
  grantId: string;
  grantVersion: number;
  scope: GrantScope;
  reboundTasks: number;
}

/** Applies an approved scope_upgrade: new grant version + rebind open tasks. */
export async function applyScopeUpgrade(approvalId: string): Promise<AppliedScopeUpgrade> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const approval = await client.query(
      `SELECT id, mission_id, status, type, payload FROM approvals WHERE id = $1 FOR UPDATE`,
      [approvalId],
    );
    if (approval.rowCount === 0) throw new Error(`approval ${approvalId} not found`);
    const row = approval.rows[0];
    if (String(row.type) !== 'scope_upgrade') throw new Error(`approval ${approvalId} is not a scope_upgrade`);
    if (String(row.status) !== 'approved') throw new Error(`approval ${approvalId} is not approved`);
    const missionId = String(row.mission_id);
    const payload = (row.payload ?? {}) as { scopeExtras?: Partial<GrantScope>; appliedGrantVersion?: number };
    if (payload.appliedGrantVersion) {
      throw new Error(`approval ${approvalId} was already applied (grant v${payload.appliedGrantVersion})`);
    }

    const mission = await client.query(
      `SELECT grant_id, grant_version FROM missions WHERE id = $1 FOR UPDATE`,
      [missionId],
    );
    if (mission.rowCount === 0) throw new Error(`mission ${missionId} not found`);
    const grantId = String(mission.rows[0].grant_id);
    const currentVersion = Number(mission.rows[0].grant_version);
    const grant = await client.query(
      `SELECT scope, constraints FROM grants WHERE id = $1 AND version = $2`,
      [grantId, currentVersion],
    );
    if (grant.rowCount === 0) throw new Error(`grant ${grantId} v${currentVersion} not found`);
    const currentScope = GrantScopeSchema.parse(grant.rows[0].scope);
    const nextScope = mergeScope(currentScope, payload.scopeExtras ?? {});
    const nextVersion = currentVersion + 1;
    await client.query(
      `INSERT INTO grants (id, version, scope, constraints, issued_by) VALUES ($1,$2,$3,$4,'approver')`,
      [grantId, nextVersion, JSON.stringify(nextScope), JSON.stringify(grant.rows[0].constraints ?? {})],
    );
    await client.query(`UPDATE missions SET grant_version = $2, updated_at = now() WHERE id = $1`, [missionId, nextVersion]);
    const rebound = await client.query(
      `UPDATE tasks SET grant_id = $2, grant_version = $3
       WHERE mission_id = $1 AND state IN ('proposed','ready','leased','running','retry_wait','blocked')`,
      [missionId, grantId, nextVersion],
    );
    await client.query(
      `UPDATE approvals SET payload = payload || $2::jsonb WHERE id = $1`,
      [approvalId, JSON.stringify({ appliedGrantVersion: nextVersion, appliedAt: new Date().toISOString() })],
    );
    await client.query(
      `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,'grant.upgraded',$2,$3)`,
      [
        missionId,
        grantId,
        JSON.stringify({ approvalId, fromVersion: currentVersion, toVersion: nextVersion, scope: nextScope }),
      ],
    );
    await client.query('COMMIT');
    return { grantId, grantVersion: nextVersion, scope: nextScope, reboundTasks: rebound.rowCount ?? 0 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Human decision on a `finding_review` approval closes the review loop. */
export async function resolveFindingReview(approvalId: string, decision: 'approved' | 'rejected'): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const approval = await client.query(
      `SELECT mission_id, type, payload FROM approvals WHERE id = $1 FOR UPDATE`,
      [approvalId],
    );
    if (approval.rowCount === 0) throw new Error(`approval ${approvalId} not found`);
    const row = approval.rows[0];
    if (String(row.type) !== 'finding_review') {
      // This helper is called for every approval decision; a non-review
      // approval must not leave the pooled client in an open transaction
      // (that leaks locks: `idle in transaction` until the pool reuses it).
      await client.query('ROLLBACK');
      return;
    }
    const findingId = String((row.payload as { findingId?: string }).findingId ?? '');
    if (!findingId) throw new Error(`approval ${approvalId} has no findingId`);
    const nextStatus = decision === 'approved' ? 'accepted' : 'rejected';
    await client.query(`UPDATE findings SET status = $2, updated_at = now() WHERE id = $1`, [findingId, nextStatus]);
    await client.query(
      `INSERT INTO events (mission_id, event_type, aggregate_id, payload) VALUES ($1,'finding.reviewed',$2,$3)`,
      [String(row.mission_id), findingId, JSON.stringify({ approvalId, decision, status: nextStatus })],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
