import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '../components/shell';
import { SettingsNav } from '../components/settings-nav';
import { useToast } from '../components/toast';
import { Button, Field, Input, Panel, SectionLabel } from '../components/ui';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PASSWORD_MIN_LENGTH, passwordRules } from '../lib/password';

// Single-admin deployment (ADR-0038): there is no user management, so the one
// administrator changes their own password here. The forced first-login flow
// uses a separate full-screen page and cannot be skipped.
export function SettingsAccount() {
  const { user, changePassword } = useAuth();
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const rules = passwordRules(newPassword);
  const strong = rules.every(rule => rule.ok);
  const matches = newPassword.length > 0 && newPassword === confirmPassword;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (!strong) return setError(`新密码必须满足全部 ${rules.length} 条规则。`);
    if (!matches) return setError('两次输入的新密码不一致。');
    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast('success', '密码已更新；当前浏览器会话已续期，其它会话已失效。');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 400) setError(cause.message);
      else setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1100px]">
      <PageHeader compact index="05 / 设置 / 账号安全" title={<>账号安全</>} />
      <SettingsNav />
      <Panel className="max-w-xl space-y-4 p-5">
        <SectionLabel>修改密码</SectionLabel>
        <p className="text-xs leading-relaxed text-muted">
          当前账号 <span className="mono text-paper">{user?.username ?? 'admin'}</span>。
          密码至少 {PASSWORD_MIN_LENGTH} 位，包含大写字母、小写字母、数字和特殊字符。
        </p>
        <form onSubmit={submit} className="space-y-4">
          <Field label="当前密码">
            <Input type={showPasswords ? 'text' : 'password'} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} autoComplete="current-password" required />
          </Field>
          <Field label={`新密码（至少 ${PASSWORD_MIN_LENGTH} 位）`}>
            <Input type={showPasswords ? 'text' : 'password'} value={newPassword} onChange={event => setNewPassword(event.target.value)} autoComplete="new-password" required />
          </Field>
          <Field label="确认新密码">
            <Input type={showPasswords ? 'text' : 'password'} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} autoComplete="new-password" required />
          </Field>
          <label className="flex items-center gap-2 text-[11px] text-muted">
            <input type="checkbox" checked={showPasswords} onChange={event => setShowPasswords(event.target.checked)} className="size-3.5 accent-lime" />
            显示密码
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
          <Button type="submit" variant="primary" icon={<KeyRound className="size-3.5" aria-hidden="true" />} disabled={busy || !strong || !matches}>
            {busy ? '保存中…' : '更新密码'}
          </Button>
        </form>
      </Panel>
    </div>
  );
}
