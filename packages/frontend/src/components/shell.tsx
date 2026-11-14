import {
  Activity,
  ArrowUpRight,
  ChevronRight,
  FileText,
  LayoutDashboard,
  Menu,
  Radar,
  Settings,
  ShieldCheck,
  Target,
  X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { canOperate } from '../lib/permissions';
import { formatShortDate, relativeTime } from '../lib/format';
import { useNow } from '../lib/hooks';
import { cn } from '../lib/utils';
import { BackgroundField } from './background';

interface NavItemDef {
  to: string;
  label: string;
  code: string;
  icon: typeof LayoutDashboard;
  end: boolean;
}

const NAV: NavItemDef[] = [
  { to: '/', label: '总览', code: '00', icon: LayoutDashboard, end: true },
  { to: '/missions', label: '项目', code: '01', icon: Target, end: false },
  { to: '/findings', label: '发现', code: '02', icon: FileText, end: false },
  { to: '/approvals', label: '审批', code: '03', icon: ShieldCheck, end: false },
];

// Pinned at the very bottom of the navigation, after the admin-only entries.
const SETTINGS_NAV: NavItemDef = { to: '/settings/models', label: '设置', code: '05', icon: Settings, end: false };
const ADMIN_NAV: NavItemDef[] = [
];

function NavItem({ to, label, code, icon: Icon, end }: NavItemDef) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'group flex items-center gap-3 border-l px-4 py-3 transition-colors',
          isActive
            ? 'border-lime bg-paper/[0.04] text-paper'
            : 'border-transparent text-muted hover:border-line hover:text-paper',
        )
      }
    >
      {({ isActive }) => (
        <>
          <span className={cn('mono w-6 text-[9px] tracking-[0.2em]', isActive ? 'text-lime' : 'text-faint')}>{code}</span>
          <Icon className={cn('size-4 transition-transform group-hover:translate-x-0.5', isActive ? 'text-lime' : '')} aria-hidden="true" />
          <span className="text-[12px] uppercase tracking-[0.16em]">{label}</span>
          {isActive ? <ChevronRight className="ml-auto size-3 text-lime" aria-hidden="true" /> : null}
        </>
      )}
    </NavLink>
  );
}

function usePageTitle(): string {
  const { pathname } = useLocation();
  if (pathname === '/') return '总览';
  if (pathname.startsWith('/missions/new')) return '新建项目';
  if (pathname.endsWith('/dag')) return '项目依赖图';
  if (pathname.endsWith('/blackboard')) return '黑板';
  if (pathname.endsWith('/board')) return '线索板';
  if (pathname.endsWith('/explore')) return '探索图';
  if (pathname.endsWith('/overview')) return '项目概览';
  if (pathname.endsWith('/assets')) return '资产图';
  if (pathname.endsWith('/traces')) return '轨迹检索';
  if (pathname.startsWith('/missions/')) return '项目详情';
  if (pathname.startsWith('/settings/evals')) return '评测与回放';
  if (pathname.startsWith('/missions')) return '项目';
  if (pathname.startsWith('/findings/')) return '发现详情';
  if (pathname.startsWith('/findings')) return '发现';
  if (pathname.startsWith('/approvals')) return '审批中心';
  if (pathname.startsWith('/settings/runtime')) return '运行时参数';
  if (pathname.startsWith('/settings/models')) return '模型配置';
  if (pathname.startsWith('/settings')) return '设置';
  if (pathname.startsWith('/trace')) return '轨迹';
  return '控制台';
}

export function Shell() {
  const { user, logout } = useAuth();
  const writable = canOperate(user);
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const now = useNow(1000);
  const title = usePageTitle();
  const compactMain = location.pathname === '/' || location.pathname.startsWith('/settings');
  const clock = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);

  return (
    <div className="relative min-h-screen bg-ink text-paper">
      <a
        href="#main-content"
        className="sr-only z-[80] bg-lime px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-ink focus:not-sr-only focus:absolute focus:left-4 focus:top-4"
      >
        跳到主要内容
      </a>
      <BackgroundField />
      <div className="pointer-events-none fixed inset-0 z-0 grid-field opacity-40" aria-hidden="true" />
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-[1800px] flex-col lg:flex-row">
        <aside className="hidden w-[252px] shrink-0 border-r border-line bg-ink/70 px-5 py-6 backdrop-blur-sm lg:flex lg:flex-col">
          <Brand />
          <nav className="mt-10 flex flex-col" aria-label="主导航">
            {NAV.map(item => <NavItem key={item.to} {...item} />)}
            {user?.role === 'admin' ? (
              <>
                {ADMIN_NAV.map(item => <NavItem key={item.to} {...item} />)}
                <NavItem {...SETTINGS_NAV} />
              </>
            ) : null}
          </nav>
          <div className="mt-auto pt-8">
            <div className="border border-line bg-panel/60 px-3 py-3">
              <div className="flex items-center justify-between">
                <span className="micro">Flotilla</span>
                <span className="pulse-dot inline-block size-1.5 rounded-full bg-lime" aria-hidden="true" />
              </div>
              <div className="mono mt-2 flex items-center justify-between text-[9px] uppercase tracking-[0.1em] text-faint">
                <span>API v1</span>
                <span>Asia/Shanghai</span>
              </div>
              <div className="mono mt-1 flex items-center justify-between text-[10px] text-lime">
                <span>{clock}</span>
                <span className="truncate pl-2 text-faint">{user?.username ?? '未登录'}{user ? ` · ${user.role}` : ''}</span>
              </div>
            </div>
            {user ? (
              <button className="mt-2 w-full border border-line px-3 py-2 text-left text-[10px] uppercase tracking-[0.12em] text-faint transition-colors hover:border-ember/35 hover:text-ember" onClick={() => void logout().then(() => navigate('/login'))}>退出登录</button>
            ) : null}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-40 flex items-center gap-4 border-b border-line bg-ink/85 px-4 py-3 backdrop-blur-md sm:px-8">
            <button
              type="button"
              className="inline-flex size-9 items-center justify-center border border-line text-muted lg:hidden"
              aria-label={mobileOpen ? '关闭导航' : '打开导航'}
              onClick={() => setMobileOpen(value => !value)}
            >
              {mobileOpen ? <X className="size-4" aria-hidden="true" /> : <Menu className="size-4" aria-hidden="true" />}
            </button>
            <div className="flex min-w-0 items-baseline gap-3">
              <span className="mono hidden text-[10px] tracking-[0.25em] text-faint sm:inline">FLOTILLA/</span>
              <h1 className="truncate text-sm font-semibold uppercase tracking-[0.18em] text-paper">{title}</h1>
            </div>
            <div className="ml-auto flex items-center gap-4">
              <span className="hidden items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted sm:flex">
                <span className="pulse-dot inline-block size-1.5 rounded-full bg-lime" aria-hidden="true" />
                实时投影
              </span>
              {writable ? <NavLink to="/missions/new" className="inline-flex items-center gap-1.5 border border-lime/50 px-3 py-1.5 text-[10px] uppercase tracking-[0.16em] text-lime transition-colors hover:bg-lime hover:text-ink">新建项目<ArrowUpRight className="size-3" aria-hidden="true" /></NavLink> : null}
            </div>
          </header>

          {mobileOpen ? (
            <div className="border-b border-line bg-ink-2 px-4 py-3 lg:hidden">
              <nav className="flex flex-col" aria-label="移动导航">
                {[...NAV, ...(user?.role === 'admin' ? [...ADMIN_NAV, SETTINGS_NAV] : [])].map(item => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    onClick={() => setMobileOpen(false)}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-3 border-l px-2 py-2.5 text-[12px] uppercase tracking-[0.14em]',
                        isActive ? 'border-lime text-paper' : 'border-transparent text-muted',
                      )
                    }
                  >
                    <item.icon className="size-4" aria-hidden="true" />
                    {item.label}
                  </NavLink>
                ))}
              </nav>
            </div>
          ) : null}

          <main id="main-content" key={location.pathname} className={cn('route-enter flex-1 px-4 sm:px-8', compactMain ? 'pb-4 pt-4 sm:pt-5' : 'pb-16 pt-6 sm:pt-9')}>
            <Outlet />
          </main>

          <footer className="border-t border-line px-4 py-4 text-[10px] uppercase tracking-[0.18em] text-faint sm:px-8">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>Flotilla · 自主渗透测试平台</span>
              <span className="mono normal-case tracking-normal">更新于 {formatShortDate(now.toISOString())} · {relativeTime(now.toISOString())}</span>
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <NavLink to="/" className="group block">
      <div className="flex items-center gap-2">
        <Radar className="size-5 text-lime transition-transform duration-500 group-hover:rotate-90" aria-hidden="true" />
        <span className="micro text-paper">Flotilla · Control Plane</span>
      </div>
      <div className="mt-3">
        <div className="display text-[26px] leading-none tracking-[-0.03em] text-paper">FLOT</div>
        <div className="display text-[26px] leading-none tracking-[-0.03em] text-lime">ILLA</div>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-muted">
        自主渗透测试平台
        <br />
        Autonomous Security Research
      </p>
    </NavLink>
  );
}

export function PageHeader({
  index,
  title,
  description,
  actions,
  aside,
  compact = false,
}: {
  index: string;
  title: ReactNode;
  description?: string;
  actions?: ReactNode;
  aside?: ReactNode;
  compact?: boolean;
}) {
  return (
    <header className="mb-8 grid gap-6 border-b border-line pb-7 lg:grid-cols-[1fr_auto] lg:items-end">
      <div>
        <div className="mb-3 flex items-center gap-2 text-[10px] uppercase tracking-[0.25em] text-muted">
          <Activity className="size-3 text-lime" aria-hidden="true" />
          <span className="mono">{index}</span>
          <span className="h-px w-8 bg-line" aria-hidden="true" />
          <span>Flotilla</span>
        </div>
        <h1 className={cn('display title-tight text-paper', compact ? 'text-[clamp(1.7rem,3.2vw,2.8rem)] leading-[1.02]' : 'text-[clamp(2.1rem,5vw,4.2rem)]')}>{title}</h1>
        {description ? <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">{description}</p> : null}
        {actions ? <div className="mt-5 flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {aside ? <div className="lg:text-right">{aside}</div> : null}
    </header>
  );
}
