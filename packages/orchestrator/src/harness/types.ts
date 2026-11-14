import type { GrantScope } from '@src-agent/contracts';

// ── Task contract between the control plane and the Harness runner ──
// Everything task-type specific is data here, so the same runner serves web
// testing, SRC hunting or future binary/APK assessments.

export interface WorkerTask {
  missionId: string;
  objective: string;
  targetUrl: string;
  scope: GrantScope;
  maxSteps: number;
  maxWallClockMs: number;
  methodology?: string;
  /** Optional P3-B4 angle for intentional same-mission parallelism. */
  angle?: string;
  /** Mission-scoped uploaded artifacts the Agent may reverse/analyze. */
  artifactIds?: string[];
  /** True for the bounded Summary/补漏 task. */
  summary?: boolean;
}
