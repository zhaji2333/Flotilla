import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MissionTargetSchema, deriveCoverageRequirements, type GrantScope, type MissionTarget } from '@src-agent/contracts';
import { buildScopeForTarget } from '@src-agent/tool-gateway';
import { getPool } from '../db';

// ── Mission creation ────────────────────────────────────────
// Creating a mission writes a grant, the mission row (target/objective/success
// criteria) and a bootstrap task in one transaction. The worker and the egress
// proxy both read from these rows, so the target truly "enters the database".

const ScopeExtrasSchema = z.object({
  domainSuffixes: z.array(z.string().min(1)).optional(),
  ips: z.array(z.string().min(1)).optional(),
  urlPrefixes: z.array(z.string().min(1)).optional(),
}).strict();

export const CreateMissionSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  target: MissionTargetSchema.optional(),
  targetMode: z.enum(['network', 'attachment']).optional(),
  objective: z.string().min(1).max(4_000),
  maxSteps: z.number().int().nonnegative().max(3000).optional(),
  maxWallClockMs: z.number().int().nonnegative().max(7_200_000).optional(),
  methodology: z.string().max(8_000).optional(),
  scopeExtras: ScopeExtrasSchema.optional(),
  // Higher priority is claimed first (human-started / urgent missions).
  priority: z.number().min(0).max(1).optional(),
  // v1.0.2 (ADR-0054): absolute deadline and reporting lead. Both are optional;
  // a mission without a deadline keeps the legacy unbounded behavior.
  deadlineAt: z.string().datetime().optional(),
  reportingLeadMs: z.number().int().min(0).max(86_400_000).optional(),
  searchPolicy: z.enum(['disabled', 'limited', 'allowed']).optional(),
  // Optional coverage gate. When set, mission completion requires the
  // observed asset graph to reach minRatio (and optionally an accepted finding).
  coverageGate: z.object({
    enabled: z.boolean().optional(),
    minRatio: z.number().min(0).max(1).optional(),
    requireAcceptedFinding: z.boolean().optional(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.target && value.targetMode !== 'attachment') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'target is required unless targetMode=attachment', path: ['target'] });
  }
  if (value.targetMode === 'attachment' && value.target?.type !== undefined && value.target.type !== 'file') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'targetMode=attachment must not include a network target', path: ['target'] });
  }
  // A file target is only a server-internal representation for attachment mode.
  // Never let a JSON or malformed multipart request create a targetless/file
  // mission without the explicit attachment flow and its artifact checks.
  if (value.target?.type === 'file' && value.targetMode !== 'attachment') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'file target requires targetMode=attachment with uploaded artifacts', path: ['target'] });
  }
});

export type CreateMissionInput = z.infer<typeof CreateMissionSchema>;

/** The target identity must be the real target, not a container-only alias. */
export function assertRealTarget(target: MissionTarget): void {
  const raw = String(target.value);
  let host = '';
  try {
    host = target.type === 'url' ? new URL(raw).hostname : raw.replace(/[/:].*$/, '');
  } catch {
    host = raw;
  }
  host = host.toLowerCase().replace(/\.$/, '');
  if (host === 'host.docker.internal' || host.endsWith('.docker.internal')) {
    throw new Error('target must use the real target host, not host.docker.internal');
  }
}

export interface CreatedMission {
  missionId: string;
  taskId: string;
  grantId: string;
  scope: GrantScope;
}

/** Attach files to the bootstrap task and make it claimable after creation. */
export async function activateBootstrapTask(taskId: string, missionId: string, artifactIds: string[]): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE tasks
       SET state = 'proposed',
           payload = jsonb_set(payload, '{artifactIds}', to_jsonb($3::text[]), true)
       WHERE id=$1 AND mission_id=$2 AND state='blocked'`,
      [taskId, missionId, artifactIds],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createMission(input: CreateMissionInput, options: { bootstrapState?: 'proposed' | 'blocked' } = {}): Promise<CreatedMission> {
  const target: MissionTarget = input.targetMode === 'attachment'
    ? { type: 'file', value: 'attachments' }
    : input.target as MissionTarget;
  if (target.type !== 'file') assertRealTarget(target);
  const scope = buildScopeForTarget(target, input.scopeExtras ?? {});
  const grantId = randomUUID();
  const budget = {
    // ARTEX-derived defaults: per-run max_turns=0 (unlimited), run wall clock=1200s.
    maxSteps: input.maxSteps ?? Number(process.env.TASK_MAX_STEPS || 0),
    maxWallClockMs: input.maxWallClockMs ?? Number(process.env.TASK_MAX_WALL_CLOCK_MS || 1_200_000),
  };
  const name = input.name?.trim() || `${target.type === 'file' ? 'attachment' : target.type}:${target.value}`;
  const payload = {
    objective: input.objective,
    target,
    ...(input.methodology ? { methodology: input.methodology } : {}),
  };

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO grants (id, version, scope, constraints, issued_by) VALUES ($1, $2, $3, $4, 'user')`,
      [
        grantId,
        1,
        JSON.stringify(scope),
        JSON.stringify({
          readOnly: false,
          excludedPaths: [],
          maxBudget: budget.maxSteps,
          allowedCategories: ['http', 'browser', 'codeExec', 'io', 'task'],
        }),
      ],
    );
    // success_criteria remains the internal completion contract. The optional
    // coverage gate is explicit; absent means ADR-0012's done/aggregate rule.
    const mission = await client.query(
      `INSERT INTO missions
         (name, state, grant_id, grant_version, target, objective, success_criteria,
          deadline_at, phase, reporting_lead_ms, search_policy)
       VALUES ($1, 'pending', $2, 1, $3, $4, $5, $6, 'active', $7, $8)
       RETURNING id`,
      [name, grantId, JSON.stringify(target), input.objective,
       JSON.stringify(input.coverageGate ? { coverageGate: input.coverageGate } : {}),
       input.deadlineAt ?? null, input.reportingLeadMs ?? 900_000, input.searchPolicy ?? 'limited'],
    );
    const missionId = String(mission.rows[0].id);
    const task = await client.query(
      `INSERT INTO tasks (mission_id, type, state, grant_id, grant_version, budget, payload, priority)
       VALUES ($1, 'bootstrap', $6, $2, 1, $3, $4, $5)
       RETURNING id`,
      [missionId, grantId, JSON.stringify(budget), JSON.stringify(payload), input.priority ?? 0.5, options.bootstrapState ?? 'proposed'],
    );
    await client.query(
      `INSERT INTO events (mission_id, event_type, aggregate_id, payload)
       VALUES ($1, 'mission.created', $2, $3)`,
      [missionId, missionId, JSON.stringify({ target, objective: input.objective, scope })],
    );
    // v1.0.2 coverage invariant (ADR-0054): seed one requirement per authorized
    // target/attack surface. Rows are additive and only used by the Planner gate.
    for (const requirement of deriveCoverageRequirements(target)) {
      await client.query(
        `INSERT INTO coverage_requirements (mission_id, target_ref, attack_surface, status)
         VALUES ($1, $2, $3, 'pending')
         ON CONFLICT (mission_id, target_ref, attack_surface) DO NOTHING`,
        [missionId, requirement.targetRef, requirement.attackSurface],
      );
    }
    await client.query(
      `INSERT INTO events (mission_id, event_type, aggregate_id, payload)
       VALUES ($1, 'task.created', $2, $3)`,
      [missionId, String(task.rows[0].id), JSON.stringify({ type: 'bootstrap', state: 'proposed' })],
    );
    // Seed the Planner's first batched reason signal.
    await client.query(
      `INSERT INTO planner_signals (mission_id, kind, payload)
       VALUES ($1, 'mission_created', $2)`,
      [missionId, JSON.stringify({ objective: input.objective })],
    );
    await client.query('COMMIT');
    return { missionId, taskId: String(task.rows[0].id), grantId, scope };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
