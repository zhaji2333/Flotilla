import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Radar } from 'lucide-react';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Field, Input } from '../components/ui';
import { SonarField } from '../components/sonar-field';
import { useAuth } from '../lib/auth';

// Bas Ording motion contract: primary entry uses critical damping (ζ = 1) with
// a non-zero initial velocity; the brand rule uses a boundary spring with a
// small rebound. Login success animates before navigating.



export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || leaving) return;
    setBusy(true);
    setError('');
    try {
      await login(username, password);
      setLeaving(true);
      const from = (location.state as { from?: string } | null)?.from ?? '/';
      window.setTimeout(() => navigate(from, { replace: true }), 480);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <main className="relative min-h-screen overflow-hidden bg-ink text-paper">
      <div className="pointer-events-none absolute inset-0 grid-field opacity-30" aria-hidden="true" />
      <div className="pointer-events-none absolute -left-32 top-1/4 h-[42rem] w-[42rem] rounded-full bg-lime/[0.06] blur-[120px]" aria-hidden="true" />
      <div className="pointer-events-none absolute -right-40 bottom-0 h-[36rem] w-[36rem] rounded-full bg-sky/[0.05] blur-[100px]" aria-hidden="true" />

      <motion.div
        className="relative z-10 mx-auto grid min-h-screen w-full max-w-[1500px] transform-gpu items-center gap-10 px-6 py-10 lg:grid-cols-[1.15fr_0.85fr] lg:px-16"
        animate={leaving ? { opacity: 0 } : { opacity: 1 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
      >
        <section className="login-rise relative isolate transform-gpu">
          <SonarField className="pointer-events-none absolute -left-40 top-1/2 -z-10 hidden size-[min(64vw,520px)] -translate-y-1/2 opacity-50 md:block" />
          <div className="relative z-10">
          <div className="mb-6 flex items-center gap-3 text-[10px] uppercase tracking-[0.26em] text-muted">
            <Radar className="size-4 text-lime" aria-hidden="true" />
            <span className="mono">FLOTILLA / CONTROL PLANE</span>
          </div>

          <h1 style={{ textTransform: 'none' }} className="display title-tight text-[clamp(2rem,3.4vw,3rem)] leading-[0.94] text-paper">
            Flotilla <span className="text-lime">—</span> 自主渗透测试平台
          </h1>
          <p className="mono mt-3 text-[10px] uppercase tracking-[0.24em] text-faint">Autonomous Security Research Platform</p>

          <div className="mt-5 h-px w-full max-w-xl overflow-hidden bg-line">
            <span className="login-rule block h-px w-full bg-lime" />
          </div>

          </div>
        </section>

        <section className="login-rise login-rise-card w-full max-w-md transform-gpu justify-self-end border border-line bg-panel/85 p-7 shadow-[0_30px_100px_rgba(0,0,0,0.45)] sm:p-8">
          <div className="flex items-center justify-between">
            <p className="micro text-lime">SECURE SESSION</p>
            <span className="pulse-dot inline-block size-1.5 rounded-full bg-lime" aria-hidden="true" />
          </div>
          <form onSubmit={submit} className="mt-6 space-y-4">
            <Field label="用户名"><Input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" required autoFocus /></Field>
            <Field label="密码"><Input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required /></Field>
            {error ? <p className="border border-ember/30 bg-ember/5 px-3 py-2 text-xs text-ember">{error}</p> : null}
            <Button type="submit" variant="primary" className="w-full" disabled={busy || leaving} icon={<ArrowRight className="size-3.5" aria-hidden="true" />}>
              {leaving ? '正在进入控制面…' : busy ? '验证中…' : '登录'}
            </Button>
          </form>

        </section>
      </motion.div>

      <AnimatePresence>
        {leaving ? (
          <motion.div
            key="enter-overlay"
            className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-ink/85"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 0.61, 0.36, 1], delay: 0.03 }}
              className="border border-lime/30 bg-panel px-8 py-5 text-center"
            >
              <p className="micro text-lime">SESSION ESTABLISHED</p>
              <p className="display mt-2 text-lg text-paper">正在进入控制面</p>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </main>
  );
}
