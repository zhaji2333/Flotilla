import { z } from 'zod';
import type { MissionFrontier } from '@src-agent/control-plane';

// ── Planner contracts ───────────────────────────────────────
// A Planner reason pass produces a bounded, validated plan. The orchestrator
// (not the model) applies it transactionally: the model can only propose.

export const CreateTaskActionSchema = z.object({
  type: z.literal('create_task'),
  objective: z.string().min(1).max(2_000),
  /** Existing task uuid or `new:N` (1-based index of an earlier create_task). */
  dependsOn: z.array(z.string().min(1)).max(8).default([]),
  /** Optional angle; different angles may run in parallel (max 2 per mission). */
  angle: z.enum(['web', 'api', 'infra', 'binary']).optional(),
}).strict();

export const AddTodoActionSchema = z.object({
  type: z.literal('add_todo'),
  content: z.string().min(1).max(500),
  position: z.number().int().nonnegative().max(200).optional(),
}).strict();

export const UpdateCheckpointActionSchema = z.object({
  type: z.literal('update_checkpoint'),
  summary: z.string().min(1).max(2_000),
}).strict();

export const UpdateTodoActionSchema = z.object({
  type: z.literal('update_todo'),
  todoId: z.union([z.string().min(1), z.number().int().positive()]).transform(String),
  status: z.enum(['pending', 'in_progress', 'done', 'completed']).transform(value => value === 'completed' ? 'done' : value),
}).strict();

export const AddHintActionSchema = z.object({
  type: z.literal('add_hint'),
  content: z.string().min(1).max(2_000),
  taskId: z.string().min(1).optional(),
  kind: z.enum(['guidance', 'help', 'report']).optional(),
}).strict();

export const CancelTaskActionSchema = z.object({
  type: z.literal('cancel_task'),
  taskId: z.string().min(1),
  reason: z.string().max(500).optional(),
}).strict();

export const PlannerActionSchema = z.discriminatedUnion('type', [
  CreateTaskActionSchema,
  AddTodoActionSchema,
  UpdateTodoActionSchema,
  UpdateCheckpointActionSchema,
  AddHintActionSchema,
  CancelTaskActionSchema,
]);

export const PlannerPlanSchema = z.object({
  analysis: z.string().min(1).max(4_000),
  actions: z.array(PlannerActionSchema).max(6).default([]),
}).strict();

export type PlannerAction = z.infer<typeof PlannerActionSchema>;
export type PlannerPlan = z.infer<typeof PlannerPlanSchema>;

export const PLANNER_MAX_ACTIONS = 6;

// ── Mission snapshot handed to the Planner ──────────────────
export interface PlannerTaskSummary {
  id: string;
  type: string;
  state: string;
  objective: string;
  attempt: number;
  dependsOn: string[];
  lastError: string | null;
}

export interface PlannerSnapshot {
  mission: {
    id: string;
    name: string;
    state: string;
    objective: string;
    targetType: string;
    targetValue: string;
    checkpoint: Record<string, unknown>;
  };
  tasks: PlannerTaskSummary[];
  findings: Array<{ id: string; title: string; artifact: string | null; status: string }>;
  assets: Array<{ type: string; value: string }>;
  todo: Array<{ id: string; content: string; status: string; position: number }>;
  /** P3-B1 typed blackboard: open intents + high-signal facts (M5 default on). */
  frontier?: MissionFrontier;
  /** M5-1 project overview sections shared with Worker/console. */
  facts?: Array<{ id: string; kind: string; key: string; value: string; summary: string; trust: string; sensitive: boolean; provenance: string; taskId: string | null }>;
  hints?: Array<{ id: string; content: string; source: string; kind: string; state: string }>;
  negatives?: { blocked: number; exhausted: number; stale: number; needsReview: number; total: number };
  traceSummary?: { totals: unknown; tasks: Array<{ taskId: string; state: string; steps: number; tokens: number; toolCalls: number; findings: number; finalText: string | null }> };
  coverage?: { total: number; covered: number; ratio: number | null };
  budget?: { tokens: number; steps: number };
  overviewVersion?: number;
}

export interface PlannerSignal {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export class PlannerPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerPlanError';
  }
}
