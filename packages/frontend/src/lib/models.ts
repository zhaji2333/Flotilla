import type { ModelTier, ModelRole, ModelReasoningEffort } from './types';
import { compactNumber } from './indicators';

export function modelRoleLabel(role: ModelRole | string | null): string {
  const labels: Record<string, string> = {
    worker: 'Worker',
    planner: 'Planner',
    scout: '侦察 (scout)',
    executor: '执行 (executor)',
    specialist: '专家 (specialist)',
    guard: '命令门控 (guard)',
  };
  if (!role) return '默认（未绑定角色）';
  return labels[role] ?? role;
}

export function modelTierLabel(tier: ModelTier | string | null): string {
  const labels: Record<string, string> = { default: '默认 (default)', fast: '快速 (fast)', strong: '强推理 (strong)' };
  if (!tier) return '未绑定层级';
  return labels[tier] ?? tier;
}

export function reasoningEffortLabel(effort: ModelReasoningEffort | string | null): string {
  if (!effort) return '未设置';
  const labels: Record<string, string> = { low: '低 (low)', high: '高 (high)', max: '最高 (max)' };
  return labels[effort] ?? effort;
}

export function modelCapacityLabel(contextWindow: number, maxOutputTokens: number): string {
  return `${compactNumber(contextWindow)} 上下文 · ${compactNumber(maxOutputTokens)} 输出`;
}

export function auditActionLabel(action: string): string {
  const labels: Record<string, string> = { create: '新建', update: '更新', delete: '删除', reveal: '查看明文 key' };
  return labels[action] ?? action;
}
