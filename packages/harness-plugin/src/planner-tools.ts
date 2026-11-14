import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { PlannerPluginConfig } from './config.js';

// ── Planner tools ───────────────────────────────────────────
// The Planner never touches the target. It reads the control-plane snapshot
// that the runner wrote and submits a structured plan; the orchestrator
// validates and applies it transactionally (auditable, same pattern as the
// worker report file).

const MAX_STATE_BYTES = 120_000;
const MAX_PLAN_BYTES = 60_000;

export function buildPlannerTools(config: PlannerPluginConfig) {
  const readMissionState = defineTool({
    name: 'read_mission_state',
    description:
      'Read the current mission snapshot (objective, tasks, findings, todo, buffered signals, assets). ' +
      'Call this once before planning; the same snapshot is also embedded in the prompt.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: String((value as { text: string }).text) }],
    },
    async execute() {
      const raw = await readFile(config.statePath, 'utf8');
      const text = raw.length > MAX_STATE_BYTES ? `${raw.slice(0, MAX_STATE_BYTES)}\n... (truncated)` : raw;
      return { text };
    },
  });

  const submitPlan = defineTool({
    name: 'submit_plan',
    description:
      'Submit the final Planner plan as a JSON object. It is the only way to change control-plane state. ' +
      'Actions: create_task {objective, dependsOn?}, add_todo {content, position?}, ' +
      'update_checkpoint {summary}, add_hint {content, taskId?}, cancel_task {taskId, reason?}.',
    parameters: {
      plan: { type: 'json', required: true, description: 'PlannerPlan object: {analysis, actions:[...]}' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: String((value as { text: string }).text) }],
    },
    async execute(args) {
      const plan = args.plan;
      if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
        return { text: 'rejected: plan must be a JSON object', accepted: false, plan_id: '' };
      }
      const serialized = `${JSON.stringify(plan, null, 2)}\n`;
      if (serialized.length > MAX_PLAN_BYTES) {
        return { text: 'rejected: plan is too large', accepted: false, plan_id: '' };
      }
      await mkdir(dirname(config.planPath), { recursive: true });
      await writeFile(config.planPath, serialized, 'utf8');
      return { text: `plan recorded (${serialized.length} bytes)`, accepted: true, plan_id: config.planPath };
    },
  });

  return { readMissionState, submitPlan };
}
