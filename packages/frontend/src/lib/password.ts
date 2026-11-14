// Mirrors packages/api/src/password-policy.ts. The API is authoritative; this
// copy only powers the live checklist and inline form feedback.

export const PASSWORD_MIN_LENGTH = 12;

export interface PasswordRule {
  id: 'length' | 'lowercase' | 'uppercase' | 'digit' | 'special';
  label: string;
  ok: boolean;
}

export function passwordRules(password: string): PasswordRule[] {
  return [
    { id: 'length', label: `至少 ${PASSWORD_MIN_LENGTH} 位`, ok: password.length >= PASSWORD_MIN_LENGTH },
    { id: 'lowercase', label: '小写字母', ok: /[a-z]/.test(password) },
    { id: 'uppercase', label: '大写字母', ok: /[A-Z]/.test(password) },
    { id: 'digit', label: '数字', ok: /[0-9]/.test(password) },
    { id: 'special', label: '特殊字符', ok: /[^A-Za-z0-9]/.test(password) },
  ];
}

export function passwordIsStrong(password: string): boolean {
  return passwordRules(password).every(rule => rule.ok);
}
