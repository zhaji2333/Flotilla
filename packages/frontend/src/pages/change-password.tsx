import { KeyRound, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Button, Field, Input } from '../components/ui';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PASSWORD_MIN_LENGTH, passwordRules } from '../lib/password';

// First-login gate. The API refuses every route except /api/auth/{me,password,
// logout} while the account still carries the bootstrap password, so this page
// is not just a UI hint: the operator cannot skip it.

export function ChangePassword() {
  const { user, changePassword, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [busy, setBusy] = useState(false);
  const rules = passwordRules(newPassword);
  const strong = rules.every(rule => rule.ok);
  const matches = newPassword.length > 0 && newPassword === confirmPassword;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (!strong) {
      setError(`新密码必须满足全部 ${rules.length} 条规则。`);
      return;
    }
    if (!matches) {
      setError('两次输入的新密码不一致。');
      return;
    }
    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
    } catch (cause) {
      // The API distinguishes a bad current password (field=currentPassword)
      // from strength violations (issues[] on newPassword).
      if (cause instanceof ApiError && cause.status === 400) {
        setError(cause.message);
      } else if (cause instanceof ApiError && cause.status === 401) {
        setError('当前密码不正确，请重新输入。');
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      setBusy(false);
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-ink px-6 py-12 text-paper">
      <div className="pointer-events-none absolute inset-0 grid-field opacity-25" aria-hidden="true" />
      <div className="pointer-events-none absolute -left-32 top-1/4 h-[38rem] w-[38rem] rounded-full bg-lime/[0.05] blur-[120px]" aria-hidden="true" />

      <section className="relative z-10 w-full max-w-lg border border-line bg-panel/85 p-7 shadow-[0_30px_100px_rgba(0,0,0,0.45)] sm:p-8">
        <div className="flex items-center justify-between">
          <p className="micro text-lime">SECURITY CHECK</p>
          <ShieldCheck className="size-4 text-lime" aria-hidden="true" />
        </div>
        <h1 className="display mt-4 text-2xl leading-tight" style={{ textTransform: 'none' }}>设置新密码</h1>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          当前账号 <span className="mono text-paper">{user?.username ?? 'admin'}</span> 仍在使用初始密码，必须先修改后才能进入控制台。
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <Field label="当前密码">
            <Input type={showPasswords ? 'text' : 'password'} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} autoComplete="current-password" required autoFocus />
            <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
              这里填你<strong className="text-muted">刚才登录时用的密码</strong>；首次登录就是初始密码 <span className="mono text-paper">admin123</span>。
              要设置的密码写在下面两栏。
            </p>
          </Field>
          <Field label={`新密码（至少 ${PASSWORD_MIN_LENGTH} 位）`}>
            <Input type={showPasswords ? 'text' : 'password'} value={newPassword} onChange={event => setNewPassword(event.target.value)} autoComplete="new-password" required />
          </Field>
          <Field label="确认新密码">
            <Input type={showPasswords ? 'text' : 'password'} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} autoComplete="new-password" required />
          </Field>
          <label className="flex items-center gap-2 text-[11px] text-muted">
            <input type="checkbox" checked={showPasswords} onChange={event => setShowPasswords(event.target.checked)} className="size-3.5 accent-lime" />
            显示密码（避免大小写/特殊字符输错）
          </label>

          <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 border border-line bg-ink/40 px-3 py-2.5 text-[11px]">
            {rules.map(rule => (
              <li key={rule.id} className={rule.ok ? 'flex items-center gap-2 text-lime' : 'flex items-center gap-2 text-muted'}>
                <span className={rule.ok ? 'inline-block size-1.5 rounded-full bg-lime' : 'inline-block size-1.5 rounded-full bg-line'} aria-hidden="true" />
                {rule.label}
              </li>
            ))}
            <li className={matches ? 'flex items-center gap-2 text-lime' : 'flex items-center gap-2 text-muted'}>
              <span className={matches ? 'inline-block size-1.5 rounded-full bg-lime' : 'inline-block size-1.5 rounded-full bg-line'} aria-hidden="true" />
              两次一致
            </li>
          </ul>

          {error ? <p className="border border-ember/30 bg-ember/5 px-3 py-2 text-xs text-ember">{error}</p> : null}

          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" icon={<KeyRound className="size-3.5" aria-hidden="true" />} disabled={busy || !strong || !matches}>
              {busy ? '保存中…' : '保存并进入控制台'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => void logout()} disabled={busy}>退出登录</Button>
          </div>
        </form>
      </section>
    </main>
  );
}
