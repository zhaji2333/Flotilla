import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Eye,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  ScrollText,
  Settings2,
  ShieldAlert,
  Star,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { DetailPanel } from '../components/detail-panel';
import { PageHeader } from '../components/shell';
import { SpringSelect } from '../components/spring-select';
import { SettingsNav } from '../components/settings-nav';
import { useToast } from '../components/toast';
import {
  Badge,
  Button,
  CopyButton,
  ErrorState,
  Field,
  Input,
  Modal,
  Panel,
  SectionLabel,
  Skeleton,
  Textarea,
} from '../components/ui';
import { api, ApiError } from '../lib/api';
import { formatDate, formatShortDate } from '../lib/format';
import { useAsync } from '../lib/hooks';
import { auditActionLabel, modelCapacityLabel, modelRoleLabel, modelTierLabel, reasoningEffortLabel } from '../lib/models';
import type { ModelConfig, ModelConfigInput, ModelConfigReveal, ModelConfigTestResult } from '../lib/types';
import { cn } from '../lib/utils';

// P3 M3 model configuration console. Admin token lives in React state only:
// never localStorage/sessionStorage/URL; it disappears when the page unmounts.
export function SettingsModels() {
  const toast = useToast();
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [actor, setActor] = useState('console-ui');
  const [tokenInput, setTokenInput] = useState('');
  const [actorInput, setActorInput] = useState('console-ui');
  const [refreshKey, setRefreshKey] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ModelConfigTestResult | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, { pending?: boolean; result?: ModelConfigTestResult; error?: string }>>({});

  const configs = useAsync(
    async () => {
      if (adminToken === null) {
        // Preflight: use the ordinary session bearer (dev fallback / nginx).
        // 403 means API_ADMIN_TOKEN is configured; ask for it explicitly.
        try {
          return await api.listModelConfigs('', actor);
        } catch (cause) {
          if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) return null;
          throw cause;
        }
      }
      return api.listModelConfigs(adminToken ?? '', actor);
    },
    [adminToken, actor, refreshKey],
  );
  const audit = useAsync(
    async () => adminToken === null
      ? { audit: [], total: 0 }
      : api.listModelConfigAudit(adminToken ?? '', actor),
    [adminToken, actor, refreshKey],
  );

  // Preflight succeeded with the ordinary session token: switch to session mode.
  useEffect(() => {
    if (adminToken === null && configs.data && !configs.loading) setAdminToken('');
  }, [adminToken, configs.data, configs.loading]);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ModelConfig | null>(null);
  const [form, setForm] = useState<ConfigForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<ModelConfig | null>(null);
  const [revealTarget, setRevealTarget] = useState<ModelConfig | null>(null);
  const [revealedKey, setRevealedKey] = useState<ModelConfigReveal | null>(null);
  const [revealSeconds, setRevealSeconds] = useState(30);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  useEffect(() => {
    if (!revealedKey) return;
    setRevealSeconds(30);
    const timer = window.setInterval(() => setRevealSeconds(value => Math.max(0, value - 1)), 1_000);
    return () => window.clearInterval(timer);
  }, [revealedKey]);

  useEffect(() => {
    if (revealedKey && revealSeconds === 0) setRevealedKey(null);
  }, [revealSeconds, revealedKey]);

  function authenticate(): void {
    if (!tokenInput.trim()) {
      toast('error', '请输入 admin token。');
      return;
    }
    setAdminToken(tokenInput.trim());
    setActor(actorInput.trim() || 'console-ui');
    setTokenInput('');
  }

  function resetProbe(): void {
    setProbeResult(null);
    setProbeError(null);
  }

  function startCreate(): void {
    resetProbe();
    setEditing(null);
    setForm({ ...EMPTY_FORM, compatText: '{}' });
    setFormError(null);
    setFormOpen(true);
  }

  function startEdit(config: ModelConfig): void {
    resetProbe();
    setEditing(config);
    setForm({
      name: config.name,
      baseUrl: config.baseUrl,
      modelName: config.modelName,
      apiKey: '',
      contextWindow: String(config.contextWindow),
      maxOutputTokens: String(config.maxOutputTokens),
      reasoningEffort: config.reasoningEffort ?? '',
      role: config.role ?? '',
      tier: config.tier ?? '',
      enabled: config.enabled,
      isDefault: config.isDefault,
      compatText: JSON.stringify(config.compat ?? {}, null, 2),
    });
    setFormError(null);
    setFormOpen(true);
  }

  function setFormField<K extends keyof ConfigForm>(key: K, value: ConfigForm[K]): void {
    setForm(current => ({ ...current, [key]: value }));
    resetProbe();
  }

  async function testFormConnection(): Promise<void> {
    resetProbe();
    const baseUrl = form.baseUrl.trim();
    const modelName = form.modelName.trim();
    if (!baseUrl || !modelName) {
      setProbeError('baseUrl / modelName 必填后才能测试。');
      return;
    }
    if (!editing && !form.apiKey.trim()) {
      setProbeError('新建配置测试需要填写 API key。');
      return;
    }
    setProbing(true);
    try {
      const result = editing
        ? await api.testModelConfigStored(adminToken ?? '', actor, editing.id, {
          baseUrl,
          modelName,
          ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        })
        : await api.testModelConfigDraft(adminToken ?? '', actor, {
          baseUrl,
          modelName,
          apiKey: form.apiKey.trim(),
        });
      setProbeResult(result);
    } catch (cause) {
      setProbeError(formatApiError(cause));
    } finally {
      setProbing(false);
    }
  }

  async function testStored(config: ModelConfig): Promise<void> {
    setProbes(current => ({ ...current, [config.id]: { pending: true } }));
    try {
      const result = await api.testModelConfigStored(adminToken ?? '', actor, config.id);
      setProbes(current => ({ ...current, [config.id]: { result } }));
    } catch (cause) {
      setProbes(current => ({ ...current, [config.id]: { error: formatApiError(cause) } }));
    }
  }

  async function submitForm(): Promise<void> {
    setFormError(null);
    if (!form.name.trim() || !form.baseUrl.trim() || !form.modelName.trim()) {
      setFormError('name / baseUrl / modelName 必填。');
      return;
    }
    if (!editing && !form.apiKey.trim()) {
      setFormError('新建配置必须填写 apiKey。');
      return;
    }
    const contextWindow = Number(form.contextWindow);
    const maxOutputTokens = Number(form.maxOutputTokens);
    if (!Number.isInteger(contextWindow) || contextWindow < 1 || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
      setFormError('上下文窗口 / 最大输出必须是正整数。');
      return;
    }
    let compat: Record<string, unknown>;
    try {
      const parsed = JSON.parse(form.compatText.trim() || '{}') as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('兼容参数必须是 JSON 对象');
      compat = parsed as Record<string, unknown>;
    } catch (cause) {
      setFormError(`兼容参数 JSON 无效：${cause instanceof Error ? cause.message : String(cause)}`);
      return;
    }
    const input: ModelConfigInput = {
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      modelName: form.modelName.trim(),
      contextWindow,
      maxOutputTokens,
      ...(form.reasoningEffort === '' ? {} : { reasoningEffort: form.reasoningEffort as ModelConfigInput['reasoningEffort'] }),
      ...(form.role === '' ? {} : { role: form.role as ModelConfigInput['role'] }),
      ...(form.tier === '' ? {} : { tier: form.tier as ModelConfigInput['tier'] }),
      enabled: form.enabled,
      isDefault: form.isDefault,
      compat,
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    };
    setSaving(true);
    try {
      if (editing) {
        await api.updateModelConfig(adminToken ?? '', actor, editing.id, input);
        toast('success', '模型配置已更新；下一个任务/下一次 Planner 运行生效。');
      } else {
        await api.createModelConfig(adminToken ?? '', actor, input);
        toast('success', '模型配置已创建；Worker/Planner 将在下一次运行时读取。');
      }
      setFormOpen(false);
      setRefreshKey(value => value + 1);
    } catch (cause) {
      setFormError(formatApiError(cause));
    } finally {
      setSaving(false);
    }
  }

  async function setDefault(config: ModelConfig): Promise<void> {
    setBusyId(config.id);
    try {
      await api.updateModelConfig(adminToken ?? '', actor, config.id, { isDefault: true });
      toast('success', `已将 ${config.name} 设为默认配置。`);
      setRefreshKey(value => value + 1);
    } catch (cause) {
      toast('error', formatApiError(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function removeConfig(): Promise<void> {
    if (!deleteTarget) return;
    setPendingAction('delete');
    try {
      await api.deleteModelConfig(adminToken ?? '', actor, deleteTarget.id);
      toast('success', `已删除 ${deleteTarget.name}。${deleteTarget.isDefault ? ' Worker/Planner 将回退 env 配置。' : ''}`);
      setDeleteTarget(null);
      setRefreshKey(value => value + 1);
    } catch (cause) {
      toast('error', formatApiError(cause));
    } finally {
      setPendingAction(null);
    }
  }

  async function revealConfig(): Promise<void> {
    if (!revealTarget) return;
    setPendingAction('reveal');
    try {
      const result = await api.revealModelConfig(adminToken ?? '', actor, revealTarget.id);
      setRevealedKey(result.config);
      setRevealTarget(null);
      setRefreshKey(value => value + 1);
    } catch (cause) {
      toast('error', formatApiError(cause));
    } finally {
      setPendingAction(null);
    }
  }

  if (adminToken === null && configs.loading) {
    return (
      <div className="mx-auto w-full max-w-[1100px]">
        <PageHeader
          compact
          index="05 / 设置 / 模型配置"
          title={<>模型配置（LLM API）</>}
          description="正在检查当前会话的管理权限…"
        />
        <div className="grid gap-3 md:grid-cols-2">{Array.from({ length: 2 }).map((_, index) => <Skeleton key={index} className="h-56 w-full" />)}</div>
      </div>
    );
  }

  if (configs.error || configs.data === null) {
    return (
      <div className="mx-auto w-full max-w-[1100px]">
        <PageHeader
          compact
          index="05 / 设置 / 模型配置"
          title={<>模型配置</>}
          description="LLM API 配置：接口地址、模型名称、API 密钥、上下文/输出容量与角色/层级。页面会先尝试当前会话令牌（开发环境未配置管理员令牌时可用）；若后端要求管理员令牌，再在此输入。"
          aside={<SecurityTokenHint />}
        />
        <SettingsNav />
        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <Panel className="p-6">
            <div className="flex items-center gap-2 text-lime">
              <Settings2 className="size-4" aria-hidden="true" />
              <span className="micro text-lime">管理员会话</span>
            </div>
            <h2 className="display mt-4 text-2xl text-paper">输入管理员令牌以管理 LLM API</h2>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              当前会话令牌没有管理权限（后端可能配置了 API_ADMIN_TOKEN）。令牌只保存在本页内存，不写 localStorage / sessionStorage / URL，刷新或离开后失效。
            </p>
            {configs.error ? <p className="mt-3 border border-ember/30 bg-ember/5 px-3 py-2 text-xs text-ember">{configs.error}</p> : null}
            <div className="mt-6 space-y-4">
              <Field label="管理员令牌 (API_ADMIN_TOKEN)" hint="后端 API_ADMIN_TOKEN；未配置时开发环境回退普通 API 令牌。">
                <Input type="password" value={tokenInput} onChange={event => setTokenInput(event.target.value)} placeholder="管理员令牌" autoComplete="off" />
              </Field>
              <Field label="操作者 (x-actor，可选)" hint="写入模型配置审计；默认 console-ui。">
                <Input value={actorInput} onChange={event => setActorInput(event.target.value)} placeholder="console-ui" />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" onClick={authenticate} icon={<Check className="size-3.5" aria-hidden="true" />}>进入管理</Button>
                <span className="text-[10px] uppercase tracking-[0.12em] text-faint">管理员令牌 · 静态 bearer</span>
              </div>
            </div>
          </Panel>
          <div className="space-y-4">
            <Panel className="p-5">
              <SectionLabel index="安全">安全边界</SectionLabel>
              <ul className="space-y-3 text-xs leading-relaxed text-muted">
                <li className="flex items-start gap-2"><ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber-300" aria-hidden="true" />模型 API 密钥以明文落库（ADR-0011，用户明确要求）；列表/审计永不返回明文，只有查看明文 (reveal) 会返回且逐次写审计。</li>
                <li className="flex items-start gap-2"><ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber-300" aria-hidden="true" />管理员令牌是静态 bearer，尚无登录会话/RBAC；不要公网部署，不要写进 URL 或本地持久化。</li>
                <li className="flex items-start gap-2"><ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber-300" aria-hidden="true" />普通 API 令牌无管理权限：未配置管理员令牌时仅开发环境回退。</li>
              </ul>
            </Panel>
          </div>
        </div>
      </div>
    );
  }

  const sessionMode = adminToken === null || adminToken === '';
  const list = configs.data?.configs ?? [];
  const auditRows = audit.data?.audit ?? [];

  return (
    <div className="mx-auto w-full max-w-[1500px]">
      <PageHeader
        compact
        index="05 / 设置 / 模型配置"
        title={<>模型配置</>}
        actions={
          <>
            <Button variant="primary" icon={<Plus className="size-3.5" aria-hidden="true" />} onClick={startCreate}>新建配置</Button>
            <Button variant="outline" icon={<RefreshCw className="size-3.5" aria-hidden="true" />} onClick={() => setRefreshKey(value => value + 1)}>刷新</Button>
            <Button variant="outline" icon={<ScrollText className="size-3.5" aria-hidden="true" />} onClick={() => { audit.refresh(); setAuditOpen(true); }}>审计日志</Button>
          </>
        }
        aside={
          <div className="border border-line bg-panel px-4 py-3 text-left">
            <p className="micro">管理员会话</p>
            <p className="mono mt-1 text-[11px] text-lime">操作者 {actor}</p>
            <p className="mono mt-1 text-[10px] text-faint">{list.length} 个配置 · {sessionMode ? '开发回退 · 会话令牌' : '管理员令牌 · 仅内存'}</p>
          </div>
        }
      />
      <SettingsNav />

      {configs.error ? (
        <div className="mb-4">
          <ErrorState error={configs.error} retry={() => setRefreshKey(value => value + 1)} />
          <p className="mt-2 text-xs text-muted">如果提示未授权 (forbidden)，请检查管理员令牌后重新输入。</p>
        </div>
      ) : null}

      {configs.loading ? (
        <div className="space-y-3" aria-busy="true">{Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-32 w-full" />)}</div>
      ) : list.length === 0 ? (
        <Panel className="p-8 text-center">
          <Settings2 className="mx-auto size-7 text-faint" aria-hidden="true" />
          <p className="display mt-4 text-lg text-paper">还没有 LLM 模型配置</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">在这里配置 LLM API：接口地址 (Base URL)、模型名称、API 密钥、上下文/输出容量。Worker / Planner 当前回退环境变量模型；创建第一条配置后自动成为默认。</p>
          <Button variant="primary" className="mt-5" onClick={startCreate} icon={<Plus className="size-3.5" aria-hidden="true" />}>创建第一条配置</Button>
        </Panel>
      ) : (
        <ul className="space-y-3">
          {list.map(config => (
            <li key={config.id}>
              <Panel className={cn('p-5', !config.enabled && 'opacity-70')}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="display text-lg text-paper">{config.name}</span>
                      {config.isDefault ? <Badge tone="lime"><Star className="size-3" aria-hidden="true" />默认</Badge> : null}
                      {config.enabled ? <Badge tone="muted">启用</Badge> : <Badge tone="ember">停用</Badge>}
                      <Badge tone="sky">{config.modelName}</Badge>
                      <span className="mono text-[10px] text-faint">{config.id.slice(0, 8)}</span>
                    </div>
                    <p className="mono mt-2 break-all text-[11px] text-muted">{config.baseUrl}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.1em] text-faint">
                      <span>{modelRoleLabel(config.role)}</span>
                      <span>{modelTierLabel(config.tier)}</span>
                      <span>思考强度 {reasoningEffortLabel(config.reasoningEffort)}</span>
                      <span>{modelCapacityLabel(config.contextWindow, config.maxOutputTokens)}</span>
                      <span>更新于 {formatShortDate(config.updatedAt)}</span>
                      {probes[config.id]?.pending ? <span className="text-sky">测试中…</span> : null}
                      {probes[config.id]?.result?.ok ? <Badge tone="lime">连接 {probes[config.id]!.result!.latencyMs}ms</Badge> : null}
                      {probes[config.id]?.result && !probes[config.id]!.result!.ok ? <Badge tone="ember">不可用</Badge> : null}
                    </div>
                    {probes[config.id]?.error ? <p className="mt-2 text-[10px] leading-relaxed text-ember">{probes[config.id]!.error}</p> : null}
                    {probes[config.id]?.result && !probes[config.id]!.result!.ok ? <p className="mt-2 text-[10px] leading-relaxed text-ember">{probes[config.id]!.result!.error}{probes[config.id]!.result!.errorCode ? ` · ${probes[config.id]!.result!.errorCode}` : ''}</p> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {!config.isDefault ? (
                      <Button variant="ghost" icon={<Star className="size-3.5" aria-hidden="true" />} disabled={busyId !== null} onClick={() => void setDefault(config)}>设为默认</Button>
                    ) : null}
                    <Button variant="outline" icon={<PlugZap className="size-3.5" aria-hidden="true" />} disabled={probes[config.id]?.pending} onClick={() => void testStored(config)}>{probes[config.id]?.pending ? '测试中…' : '测试'}</Button>
                    <Button variant="outline" icon={<Pencil className="size-3.5" aria-hidden="true" />} onClick={() => startEdit(config)}>编辑</Button>
                    <Button variant="outline" icon={<Eye className="size-3.5" aria-hidden="true" />} onClick={() => setRevealTarget(config)}>查看明文</Button>
                    <Button variant="ghost" icon={<Trash2 className="size-3.5" aria-hidden="true" />} onClick={() => setDeleteTarget(config)}>删除</Button>
                  </div>
                </div>
                <div className="mt-4 grid gap-px border border-line bg-line sm:grid-cols-3">
                  <div className="bg-ink-2 px-3 py-2.5">
                    <p className="text-[9px] uppercase tracking-[0.12em] text-faint">API 密钥</p>
                    <p className="mono mt-1 text-xs text-paper">{config.apiKeySet ? config.apiKeyMasked ?? '••••••' : '未设置'}</p>
                  </div>
                  <div className="bg-ink-2 px-3 py-2.5">
                    <p className="text-[9px] uppercase tracking-[0.12em] text-faint">密钥环境变量</p>
                    <p className="mono mt-1 truncate text-xs text-muted">{config.apiKeyEnv || '—'}</p>
                  </div>
                  <div className="bg-ink-2 px-3 py-2.5">
                    <p className="text-[9px] uppercase tracking-[0.12em] text-faint">兼容参数</p>
                    <p className="mono mt-1 truncate text-xs text-muted">{Object.keys(config.compat ?? {}).length > 0 ? JSON.stringify(config.compat) : '{}'}</p>
                  </div>
                </div>
              </Panel>
            </li>
          ))}
        </ul>
      )}


      {/* create / edit */}
      <Modal
        open={formOpen}
        onOpenChange={open => { if (!open && !saving) setFormOpen(false); }}
        title={editing ? `编辑 ${editing.name}` : '新建模型配置'}
        description="保存后无需重启：Worker 在领取任务、Planner 在推理时读取最新配置。API 密钥编辑时留空 = 不修改。"
        footer={
          <>
            <Button variant="ghost" disabled={saving} onClick={() => setFormOpen(false)}>取消</Button>
            <Button variant="primary" disabled={saving} onClick={() => void submitForm()}>{saving ? '保存中…' : editing ? '保存修改' : '创建配置'}</Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="名称"><Input value={form.name} onChange={event => setFormField('name', event.target.value)} placeholder="deepseek-flash-default" /></Field>
          <Field label="模型名称"><Input value={form.modelName} onChange={event => setFormField('modelName', event.target.value)} placeholder="deepseek-flash" /></Field>
          <div className="sm:col-span-2">
            <Field label="接口地址 (Base URL)"><Input value={form.baseUrl} onChange={event => setFormField('baseUrl', event.target.value)} placeholder="https://api.deepseek.com/v1" /></Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="API 密钥" hint={editing ? '留空表示复用已保存密钥；测试会使用已保存的 key。' : '新配置必填；测试连接会真实调用一次 chat completion。'}>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input type="password" value={form.apiKey} onChange={event => setFormField('apiKey', event.target.value)} placeholder={editing ? '留空不修改' : 'sk-...'} autoComplete="off" className="flex-1" />
                <Button variant="outline" type="button" icon={<PlugZap className="size-3.5" aria-hidden="true" />} disabled={probing || saving} onClick={() => void testFormConnection()}>{probing ? '测试中…' : '测试连接'}</Button>
              </div>
            </Field>
            {probeError ? <p className="mt-2 border border-ember/30 bg-ember/5 px-3 py-2 text-xs text-ember">{probeError}</p> : null}
            {probeResult ? <ProbeBanner result={probeResult} /> : null}
          </div>
          <Field label="上下文窗口"><Input type="number" min={1} value={form.contextWindow} onChange={event => setFormField('contextWindow', event.target.value)} /></Field>
          <Field label="最大输出 token 数"><Input type="number" min={1} value={form.maxOutputTokens} onChange={event => setFormField('maxOutputTokens', event.target.value)} /></Field>
          <Field label="思考强度">
            <SpringSelect
              value={form.reasoningEffort}
              onChange={value => setFormField('reasoningEffort', value)}
              ariaLabel="模型思考强度"
              fullWidth
              size="field"
              options={[{ value: '', label: '未设置' }, { value: 'low', label: '低 (low)' }, { value: 'high', label: '高 (high)' }, { value: 'max', label: '最高 (max)' }]}
            />
          </Field>
          <Field label="角色">
            <SpringSelect
              value={form.role}
              onChange={value => setFormField('role', value)}
              ariaLabel="模型角色"
              fullWidth
              size="field"
              options={[{ value: '', label: '默认（未绑定）' }, { value: 'worker', label: 'Worker' }, { value: 'planner', label: 'Planner' }, { value: 'scout', label: '侦察 (scout)' }, { value: 'executor', label: '执行 (executor)' }, { value: 'specialist', label: '专家 (specialist)' }, { value: 'guard', label: '命令门控 (guard)' }]}
            />
          </Field>
          <Field label="层级">
            <SpringSelect
              value={form.tier}
              onChange={value => setFormField('tier', value)}
              ariaLabel="模型层级"
              fullWidth
              size="field"
              options={[{ value: '', label: '未绑定' }, { value: 'default', label: '默认 (default)' }, { value: 'fast', label: '快速 (fast)' }, { value: 'strong', label: '强推理 (strong)' }]}
            />
          </Field>
          <div className="flex items-end gap-4">
            <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={form.enabled} onChange={event => setFormField('enabled', event.target.checked)} />启用</label>
            <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={form.isDefault} onChange={event => setFormField('isDefault', event.target.checked)} />设为默认</label>
          </div>
          <div className="sm:col-span-2">
            <Field label="兼容参数 JSON" hint="网关兼容字段，例如 thinkingFormat / headers；必须是 JSON 对象。">
              <Textarea value={form.compatText} onChange={event => setFormField('compatText', event.target.value)} rows={5} className="mono text-xs" />
            </Field>
          </div>
        </div>
        {formError ? <p className="mt-3 border border-ember/30 bg-ember/5 px-3 py-2 text-xs text-ember">{formError}</p> : null}
      </Modal>

      {/* reveal */}
      <Modal
        open={revealTarget !== null}
        onOpenChange={open => { if (!open && pendingAction !== 'reveal') setRevealTarget(null); }}
        title="查看明文 API 密钥？"
        description={`将显示 ${revealTarget?.name ?? ''} 的明文密钥。每次查看都会写入审计；明文仅供当前操作短暂显示。`}
        footer={
          <>
            <Button variant="ghost" disabled={pendingAction === 'reveal'} onClick={() => setRevealTarget(null)}>取消</Button>
            <Button variant="danger" disabled={pendingAction === 'reveal'} onClick={() => void revealConfig()}>{pendingAction === 'reveal' ? '读取中…' : '确认查看并写审计'}</Button>
          </>
        }
      >
        <p className="text-xs leading-relaxed text-muted">不要把 API 密钥复制到聊天、URL、日志或 localStorage。关闭后页面不保留明文。</p>
      </Modal>

      <Modal
        open={revealedKey !== null}
        onOpenChange={open => { if (!open) setRevealedKey(null); }}
        title={revealedKey ? `明文密钥 · ${revealedKey.name}` : '明文密钥'}
        description={`将在 ${revealSeconds}s 后自动隐藏。`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevealedKey(null)}>立即隐藏</Button>
          </>
        }
      >
        {revealedKey ? (
          <div>
            <div className="flex items-center justify-between gap-3 border border-amber-300/30 bg-amber-300/5 px-3 py-3">
              <code className="mono break-all text-xs text-amber-100">{revealedKey.apiKey}</code>
            </div>
            <p className="mt-3 text-[11px] text-muted">更新于 {formatDate(revealedKey.updatedAt)}。此操作已写审计；不要截图或转发。</p>
          </div>
        ) : null}
      </Modal>

      {/* delete */}
      <Modal
        open={deleteTarget !== null}
        onOpenChange={open => { if (!open && pendingAction !== 'delete') setDeleteTarget(null); }}
        title={deleteTarget ? `删除 ${deleteTarget.name}？` : '删除配置'}
        description={deleteTarget?.isDefault ? '这是当前默认配置，删除后 Worker/Planner 将回退 env 配置。' : '删除后不可恢复；Worker/Planner 下一次运行读取最新配置。'}
        footer={
          <>
            <Button variant="ghost" disabled={pendingAction === 'delete'} onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="danger" disabled={pendingAction === 'delete'} onClick={() => void removeConfig()}>{pendingAction === 'delete' ? '删除中…' : '确认删除'}</Button>
          </>
        }
      >
        <p className="text-xs leading-relaxed text-muted">配置与审计记录会保留在数据库中；页面列表会刷新。</p>
      </Modal>

      <DetailPanel
        open={auditOpen}
        onOpenChange={setAuditOpen}
        title="模型配置审计"
        description="列表/审计永不返回明文密钥；查看明文、创建、更新与删除都会记录。"
        footer={<span className="micro">{auditRows.length} / 200 条记录</span>}
      >
        {audit.loading ? <Skeleton className="h-32 w-full" /> : auditRows.length === 0 ? (
          <p className="text-sm text-muted">暂无审计记录。</p>
        ) : (
          <ul className="divide-y divide-line">
            {auditRows.map(row => (
              <li key={row.id} className="py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-paper">
                    <span className={row.action === 'reveal' ? 'text-amber-300' : 'text-lime'}>{auditActionLabel(row.action)}</span>
                    {' · '}{row.configName || row.configId?.slice(0, 8) || '—'}
                  </p>
                  <span className="mono text-[10px] text-faint">{formatDate(row.createdAt)}</span>
                </div>
                <p className="mono mt-1 text-[10px] text-faint">操作者 {row.actor}</p>
                {row.detail ? <p className="mono mt-1 break-all text-[9px] text-faint">{JSON.stringify(row.detail)}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </DetailPanel>
    </div>
  );
}

function ProbeBanner({ result }: { result: ModelConfigTestResult }) {
  const usage = result.usage?.total_tokens;
  return (
    <div className={cn('mt-2 border px-3 py-2.5 text-xs', result.ok ? 'border-lime/30 bg-lime/5' : 'border-ember/30 bg-ember/5')}>
      <div className="flex flex-wrap items-center gap-2">
        {result.ok ? <CheckCircle2 className="size-3.5 text-lime" aria-hidden="true" /> : <AlertTriangle className="size-3.5 text-ember" aria-hidden="true" />}
        <span className={result.ok ? 'text-lime' : 'text-ember'}>
          {result.ok
            ? `连接成功 · ${result.latencyMs}ms${result.model ? ` · ${result.model}` : ''}${typeof usage === 'number' ? ` · ${usage} tokens` : ''}`
            : result.error ?? '连接失败'}
        </span>
      </div>
      <div className="mono mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-faint">
        <span>{result.latencyMs}ms</span>
        {result.httpStatus !== null ? <span>HTTP {result.httpStatus}</span> : null}
        {result.errorCode ? <span>{result.errorCode}</span> : null}
        {result.model ? <span>model {result.model}</span> : null}
        {typeof usage === 'number' ? <span>{usage} tokens</span> : null}
        {result.traceId ? <span className="inline-flex items-center gap-1">trace {result.traceId.slice(0, 22)}… <CopyButton value={result.traceId} label="" /></span> : null}
      </div>
    </div>
  );
}

interface ConfigForm {
  name: string;
  baseUrl: string;
  modelName: string;
  apiKey: string;
  contextWindow: string;
  maxOutputTokens: string;
  reasoningEffort: string;
  role: string;
  tier: string;
  enabled: boolean;
  isDefault: boolean;
  compatText: string;
}

const EMPTY_FORM: ConfigForm = {
  name: '',
  baseUrl: 'https://api.deepseek.com/v1',
  modelName: '',
  apiKey: '',
  contextWindow: '1000000',
  maxOutputTokens: '393216',
  reasoningEffort: 'max',
  role: '',
  tier: '',
  enabled: true,
  isDefault: false,
  compatText: '{}',
};

function formatApiError(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401) return `${cause.message}（admin token 缺失或无效）`;
    if (cause.status === 403) return `${cause.message}（需要 API_ADMIN_TOKEN 管理权限）`;
    return cause.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

function SecurityTokenHint() {
  return (
    <div className="border border-amber-300/25 bg-amber-300/5 px-4 py-3 text-left">
      <p className="micro flex items-center gap-1.5 text-amber-300"><AlertTriangle className="size-3" aria-hidden="true" />仅管理员</p>
      <p className="mt-2 max-w-xs text-[10px] leading-relaxed text-amber-100/70">
        令牌仅内存；刷新或离开页面后失效。模型 API 密钥明文落库，仅“查看明文”返回且逐次审计。
      </p>
    </div>
  );
}
