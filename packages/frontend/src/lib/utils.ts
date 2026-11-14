import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function pct(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((value / total) * 100);
}
