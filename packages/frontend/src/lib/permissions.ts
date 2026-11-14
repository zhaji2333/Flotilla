import type { AuthUser } from './types';

/** Mutations for mission/hint/approval work are operator/admin only. */
export function canOperate(user: AuthUser | null | undefined): boolean {
  return user?.role === 'admin' || user?.role === 'operator';
}

/** Admin-only surfaces: accounts, runtime settings, model config, project delete. */
export function canAdmin(user: AuthUser | null | undefined): boolean {
  return user?.role === 'admin';
}
