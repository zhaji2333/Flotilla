// ── Password policy ─────────────────────────────────────────
// One administrator account guards the whole deployment, so the console
// password must actually be strong: at least 12 characters with lowercase,
// uppercase, digit and special character. The bootstrap password (admin123) is
// allowed only because the first login must change it.
//
// The same rules are mirrored in the SPA for inline hints; the server is the
// authority and re-validates every change.

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 500;

export interface PasswordViolation {
  code: 'too_short' | 'too_long' | 'lowercase' | 'uppercase' | 'digit' | 'special';
  message: string;
}

/** Returns every rule the candidate password breaks (empty => acceptable). */
export function passwordViolations(password: string): PasswordViolation[] {
  const violations: PasswordViolation[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    violations.push({ code: 'too_short', message: `至少 ${PASSWORD_MIN_LENGTH} 位` });
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    violations.push({ code: 'too_long', message: `最多 ${PASSWORD_MAX_LENGTH} 位` });
  }
  if (!/[a-z]/.test(password)) violations.push({ code: 'lowercase', message: '需要小写字母' });
  if (!/[A-Z]/.test(password)) violations.push({ code: 'uppercase', message: '需要大写字母' });
  if (!/[0-9]/.test(password)) violations.push({ code: 'digit', message: '需要数字' });
  if (!/[^A-Za-z0-9]/.test(password)) violations.push({ code: 'special', message: '需要特殊字符' });
  return violations;
}

export function passwordIsStrong(password: string): boolean {
  return passwordViolations(password).length === 0;
}

/** Human-readable summary used in API error bodies. */
export function passwordPolicyMessage(): string {
  return `密码至少 ${PASSWORD_MIN_LENGTH} 位，且必须包含大写字母、小写字母、数字和特殊字符`;
}
