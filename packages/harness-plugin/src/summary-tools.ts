import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { MissionSummarySchema, type MissionSummary } from '@src-agent/contracts';

// ── Summary task tool ───────────────────────────────────────
// A summary task is read-only: it may inspect the mission context and submit one
// bounded review document. It has no target HTTP tools and cannot report
// findings, so it cannot silently create new attack surface.

export interface SummaryToolConfig {
  summaryPath: string;
}

export function buildSummaryTools(config: SummaryToolConfig) {
  const submitSummary = defineTool({
    name: 'submit_summary',
    description:
      'Submit the mission coverage review. Use after reading the mission brief, findings, asset coverage and recent traces. ' +
      'The review is bounded and must only suggest missing checks; it cannot perform target requests.',
    parameters: {
      markdown: { type: 'string', required: true, description: 'Bounded review in Markdown (<=8000 chars).' },
      coverage_assessment: { type: 'string', description: 'What is covered and what is not (<=2000 chars).' },
      objective_achieved: {
        type: 'boolean',
        description: 'True when the mission objective is already met (e.g. every expected flag is an accepted finding); the controller then produces the report only.',
      },
      gaps: {
        type: 'json',
        description: 'Array of {area, reason, suggestedCheck, confidence}; max 20.',
      },
      duplicate_finding_ids: { type: 'json', description: 'Optional IDs of suspected duplicate findings.' },
      missing_evidence_ids: { type: 'json', description: 'Optional IDs of findings lacking evidence.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: String((value as { text: string }).text) }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const candidate = {
        markdown: String(args.markdown ?? ''),
        ...(args.coverage_assessment ? { coverageAssessment: String(args.coverage_assessment) } : {}),
        ...(typeof args.objective_achieved === 'boolean' ? { objectiveAchieved: args.objective_achieved } : {}),
        gaps: Array.isArray(args.gaps) ? args.gaps : [],
        duplicateFindingIds: Array.isArray(args.duplicate_finding_ids) ? args.duplicate_finding_ids : [],
        missingEvidenceIds: Array.isArray(args.missing_evidence_ids) ? args.missing_evidence_ids : [],
      };
      const parsed = MissionSummarySchema.safeParse(candidate);
      if (!parsed.success) {
        return { text: `summary rejected: ${JSON.stringify(parsed.error.issues).slice(0, 2_000)}` };
      }
      const summary: MissionSummary = parsed.data;
      await mkdir(dirname(config.summaryPath), { recursive: true });
      const temporary = `${config.summaryPath}.tmp-${process.pid}`;
      await writeFile(temporary, JSON.stringify(summary, null, 2), 'utf8');
      await rename(temporary, config.summaryPath);
      return { text: `summary submitted (${summary.gaps.length} gap(s))` };
    },
  });
  return { submitSummary };
}
