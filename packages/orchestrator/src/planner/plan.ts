import { createHash, randomUUID } from 'node:crypto';
import { PlannerPlanSchema, PlannerPlanError, PLANNER_MAX_ACTIONS, type PlannerAction, type PlannerPlan } from './types.js';

// ── Plan validation (pure) ──────────────────────────────────
// Rejects plans that exceed the action budget, reference unknown/forward
// dependencies, or target tasks that are not open. All checks run before any
// database write.

export interface PlanValidationContext {
  knownTaskIds: ReadonlySet<string>;
  openTaskIds: ReadonlySet<string>;
}

export interface ValidatedPlan {
  plan: PlannerPlan;
  /** Dependency references resolved to task ids or `new:N` placeholders. */
  creates: Array<{ actionIndex: number; id: string; action: Extract<PlannerAction, { type: 'create_task' }> }>;
}

export function parsePlan(raw: unknown): PlannerPlan {
  const parsed = PlannerPlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PlannerPlanError(`invalid planner plan: ${parsed.error.issues.map(issue => issue.path.join('.') + ' ' + issue.message).join('; ')}`);
  }
  if (parsed.data.actions.length > PLANNER_MAX_ACTIONS) {
    throw new PlannerPlanError(`plan has ${parsed.data.actions.length} actions (max ${PLANNER_MAX_ACTIONS})`);
  }
  return parsed.data;
}

/** Validates inter-action references and returns create_task ids assigned up front. */
export function validatePlan(plan: PlannerPlan, context: PlanValidationContext): ValidatedPlan {
  const creates: ValidatedPlan['creates'] = [];
  const seenNew = new Map<number, string>();
  let createIndex = 0;

  plan.actions.forEach((action, actionIndex) => {
    if (action.type === 'create_task') {
      createIndex += 1;
      const id = randomUUID();
      for (const dependency of action.dependsOn) {
        if (/^new:\d+$/.test(dependency)) {
          const referenced = Number(dependency.slice(4));
          if (!Number.isInteger(referenced) || referenced < 1 || referenced >= createIndex) {
            throw new PlannerPlanError(`create_task #${createIndex} depends on forward/unknown plan item ${dependency}`);
          }
          const resolved = seenNew.get(referenced);
          if (!resolved) throw new PlannerPlanError(`create_task #${createIndex} depends on missing plan item ${dependency}`);
          continue;
        }
        if (!context.knownTaskIds.has(dependency)) {
          throw new PlannerPlanError(`create_task #${createIndex} depends on unknown task ${dependency}`);
        }
      }
      seenNew.set(createIndex, id);
      creates.push({ actionIndex, id, action });
    } else if (action.type === 'cancel_task') {
      const refIndex = createRefIndex(action.taskId);
      if (refIndex !== null) {
        if (refIndex < 1 || refIndex > creates.length) {
          throw new PlannerPlanError(`cancel_task references unknown plan item ${action.taskId}`);
        }
      } else if (!context.openTaskIds.has(action.taskId)) {
        throw new PlannerPlanError(`cancel_task targets a missing or already-finished task ${action.taskId}`);
      }
    } else if (action.type === 'add_hint' && action.taskId) {
      const refIndex = createRefIndex(action.taskId);
      if (refIndex !== null) {
        if (refIndex < 1 || refIndex > creates.length) {
          throw new PlannerPlanError(`add_hint references unknown plan item ${action.taskId}`);
        }
      } else if (!context.knownTaskIds.has(action.taskId)) {
        throw new PlannerPlanError(`add_hint targets unknown task ${action.taskId}`);
      }
    }
  });

  return { plan, creates };
}

export function resolveDependencies(dependsOn: readonly string[], creates: ValidatedPlan['creates']): string[] {
  return dependsOn.map(dependency => resolvePlanRef(dependency, creates));
}

/** Resolves a task reference: an existing task id or `new:N` within this plan. */
export function resolvePlanRef(ref: string, creates: ValidatedPlan['creates']): string {
  if (/^new:\d+$/.test(ref)) {
    const referenced = Number(ref.slice(4));
    const match = creates[referenced - 1];
    if (!match) throw new PlannerPlanError(`unresolvable plan task reference ${ref}`);
    return match.id;
  }
  return ref;
}

/** Returns the creates referenced by a task ref, for validation of cancel/hint targets. */
export function createRefIndex(ref: string): number | null {
  if (!/^new:\d+$/.test(ref)) return null;
  return Number(ref.slice(4));
}

export function taskFingerprint(objective: string, targetValue: string, angle?: string | null): string {
  return createHash('sha256').update(`${targetValue}\n${objective}\n${angle ?? ''}`).digest('hex');
}
