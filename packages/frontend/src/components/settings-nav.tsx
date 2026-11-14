import { FlaskConical, KeyRound, Radar, Settings2, SlidersHorizontal } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { cn } from '../lib/utils';

const SETTINGS_LINKS = [
  { to: '/settings/models', label: '模型配置', icon: Settings2 },
  { to: '/settings/runtime', label: '运行时参数', icon: SlidersHorizontal },
  { to: '/settings/evals', label: '评测与回放', icon: FlaskConical },
  { to: '/settings/account', label: '账号安全', icon: KeyRound },
  { to: '/settings/watchdog', label: 'Watchdog', icon: Radar },
];

export function SettingsNav() {
  return (
    <nav aria-label="设置子导航" className="mb-4 flex flex-wrap gap-2 border-b border-line pb-3">
      {SETTINGS_LINKS.map(link => {
        const Icon = link.icon;
        return (
          <NavLink
            key={link.to}
            to={link.to}
            className={({ isActive }) => cn(
              'inline-flex items-center gap-2 border px-3 py-2 text-[10px] uppercase tracking-[0.14em] transition-colors',
              isActive ? 'border-lime/45 bg-lime/10 text-lime' : 'border-line text-muted hover:border-lime/30 hover:text-paper',
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {link.label}
          </NavLink>
        );
      })}
    </nav>
  );
}
