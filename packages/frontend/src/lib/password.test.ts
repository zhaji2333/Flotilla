import { describe, expect, it } from 'vitest';
import { PASSWORD_MIN_LENGTH, passwordIsStrong, passwordRules } from './password';

describe('password checklist', () => {
  it('accepts a compliant password', () => {
    expect(passwordIsStrong('Str0ng!Passw')).toBe(true);
    expect(passwordRules('Str0ng!Passw').every(rule => rule.ok)).toBe(true);
  });

  it('flags the bootstrap password', () => {
    const failed = passwordRules('admin123').filter(rule => !rule.ok).map(rule => rule.id);
    expect(failed).toEqual(['length', 'uppercase', 'special']);
    expect(passwordIsStrong('admin123')).toBe(false);
  });

  it('uses the same minimum length as the API', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(passwordRules('Ab1!abcdxyz')[0]?.ok).toBe(false);
    expect(passwordRules('Ab1!abcdxyzw')[0]?.ok).toBe(true);
  });
});
