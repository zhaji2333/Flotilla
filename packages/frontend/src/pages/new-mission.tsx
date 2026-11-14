import { ArrowRight, CheckCircle2, Crosshair, FileArchive, SlidersHorizontal, Sparkles, Target, UploadCloud, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/shell';
import { useToast } from '../components/toast';
import { Button, CopyButton, ErrorState, Field, Input, Panel, Textarea } from '../components/ui';
import { SpringSelect } from '../components/spring-select';
import { api, ApiError, MAX_ARTIFACT_BYTES } from '../lib/api';
import { formatBytes } from '../lib/format';
import type { CreateMissionRequest, CreatedMission } from '../lib/types';
import { cn } from '../lib/utils';

type NetworkTargetType = 'url' | 'ip' | 'domain';
type TargetChoice = NetworkTargetType | 'attachment';

interface FormState {
  targetType: TargetChoice | '';
  targetValue: string;
  name: string;
  objective: string;
  priority: string;
  maxSteps: string;
  maxWallClockMs: string;
  methodology: string;
  domainSuffixes: string;
  ips: string;
  urlPrefixes: string;
}

const INITIAL: FormState = {
  targetType: '',
  targetValue: '',
  name: '',
  objective: '',
  priority: '0.5',
  maxSteps: '0',
  maxWallClockMs: '0',
  methodology: '',
  domainSuffixes: '',
  ips: '',
  urlPrefixes: '',
};

function validate(form: FormState, fileCount: number): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.targetType) errors.targetType = '请选择目标类型。';
  if (form.targetType === 'attachment' && fileCount === 0) errors.attachments = '附件项目至少需要上传一个附件。';
  if (form.targetType !== 'attachment') {
    const target = form.targetValue.trim();
    if (!target) errors.targetValue = '目标不能为空。';
    else if (form.targetType === 'url' && !/^https?:\/\/[^\s]+$/i.test(target)) errors.targetValue = 'URL 需以 http:// 或 https:// 开头。';
    else if (form.targetType === 'ip' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(target)) errors.targetValue = '请输入合法 IPv4 地址。';
    else if (form.targetType === 'domain' && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(target)) errors.targetValue = '请输入合法域名，例如 app.example.com。';
    else if (/host\.docker\.internal/i.test(target)) errors.targetValue = '请填写真实目标 host；本地 host-only 靶场由服务端 PROXY_CONNECT_OVERRIDES 处理，不要使用 host.docker.internal。';
  }
  if (form.objective.trim().length < 10) errors.objective = '目标描述至少 10 个字符，写清范围与成功标准。';
  const steps = Number(form.maxSteps);
  if (!Number.isInteger(steps) || steps < 0) errors.maxSteps = '步数上限需为不小于 0 的整数（0 表示不限）。';
  const wallClock = Number(form.maxWallClockMs);
  if (!Number.isInteger(wallClock) || wallClock < 0) errors.maxWallClockMs = '墙钟上限需为不小于 0 的整数毫秒（0 表示不限）。';
  return errors;
}

function parseList(value: string): string[] | undefined {
  const list = value.split(/[\n,]+/).map(item => item.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

export function NewMission() {
  const toast = useToast();
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<CreatedMission | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState('');
  const [progress, setProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  function addFiles(incoming: FileList | File[]): void {
    setFileError('');
    const accepted: File[] = [];
    const messages: string[] = [];
    for (const file of incoming) {
      if (files.length + accepted.length >= 20) {
        messages.push('最多选择 20 个附件。');
        break;
      }
      if (file.size === 0) {
        messages.push(`${file.name} 为空文件，已跳过。`);
        continue;
      }
      if (file.size > MAX_ARTIFACT_BYTES) {
        messages.push(`${file.name} 超过 2GB，已跳过。`);
        continue;
      }
      accepted.push(file);
    }
    if (messages.length > 0) setFileError(messages.join(' '));
    if (accepted.length > 0) {
      setFiles(current => [...current, ...accepted].slice(0, 20));
      clearAttachmentError();
    }
  }

  function clearAttachmentError(): void {
    setErrors(current => {
      if (!('attachments' in current)) return current;
      const next = { ...current };
      delete next.attachments;
      return next;
    });
  }

  function removeFile(index: number): void {
    setFiles(current => current.filter((_, at) => at !== index));
    clearAttachmentError();
  }

  function resetForAnother(): void {
    setCreated(null);
    setForm(INITIAL);
    setErrors({});
    setFiles([]);
    setFileError('');
    setServerError(null);
    setProgress(0);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  const targetPreview = useMemo(() => {
    if (form.targetType === 'attachment') return '纯附件';
    return form.targetValue.trim() || (form.targetType === 'url' ? 'https://…' : form.targetType ? '待填写目标' : '待选择目标');
  }, [form.targetValue, form.targetType]);
  const objectiveLength = form.objective.trim().length;

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm(current => ({ ...current, [key]: value }));
    setErrors(current => {
      const next = { ...current };
      delete next[key];
      if (key === 'targetType') {
        delete next.targetValue;
        delete next.attachments;
      }
      return next;
    });
  }

  async function submit(): Promise<void> {
    const nextErrors = validate(form, files.length);
    setErrors(nextErrors);
    setServerError(null);
    if (Object.keys(nextErrors).length > 0) {
      toast('error', '请先修正表单中的错误。');
      return;
    }
    setPending(true);
    setProgress(0);
    try {
      const targetType = form.targetType;
      if (!targetType) return;
      const baseInput = {
        name: form.name.trim() || undefined,
        objective: form.objective.trim(),
        priority: Number(form.priority),
        maxSteps: Number(form.maxSteps),
        maxWallClockMs: Number(form.maxWallClockMs),
        methodology: form.methodology.trim() || undefined,
        ...(targetType === 'attachment' ? {} : {
          scopeExtras: {
            domainSuffixes: parseList(form.domainSuffixes),
            ips: parseList(form.ips),
            urlPrefixes: parseList(form.urlPrefixes),
          },
        }),
      };
      let result: CreatedMission;
      if (targetType === 'attachment') {
        const controller = new AbortController();
        abortRef.current = controller;
        result = await api.createMissionMultipart({ ...baseInput, targetMode: 'attachment' }, files, setProgress, controller.signal);
      } else if (files.length > 0) {
        const controller = new AbortController();
        abortRef.current = controller;
        const input: CreateMissionRequest = { ...baseInput, target: { type: targetType, value: form.targetValue.trim() } };
        result = await api.createMissionMultipart(input, files, setProgress, controller.signal);
      } else {
        const input: CreateMissionRequest = { ...baseInput, target: { type: targetType, value: form.targetValue.trim() } };
        result = await api.createMission(input);
      }
      setCreated(result);
      toast('success', files.length > 0 ? `项目已创建，附件 ${result.artifacts?.length ?? files.length} 个已加入 bootstrap task。` : '项目已创建，Worker 将自动领取。');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 0) {
        setServerError('创建已取消；如服务端已完成创建，请到项目列表确认。');
      } else if (cause instanceof ApiError && cause.issues.length > 0) {
        setServerError(`${cause.message}（校验字段 ${cause.issues.length} 个）`);
      } else {
        setServerError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      abortRef.current = null;
      setPending(false);
      setProgress(0);
    }
  }

  if (created) {
    return (
      <div className="mx-auto w-full max-w-[1100px]">
        <PageHeader
          index="01 / 项目 / 已创建"
          title={<>项目已创建</>}
          description={form.targetType === 'attachment' ? '附件已与项目一起写入；Worker 会自动领取并可在审计代理下发起网络请求。' : '目标已写入 PostgreSQL，授权范围随 grant 下发；Worker 会自动领取任务。'}
          actions={
            <>
              <Link to={`/missions/${created.missionId}`} className="btn btn-primary">
                打开项目详情 <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
              <Button variant="outline" onClick={resetForAnother}>再建一个</Button>
            </>
          }
        />
        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <Panel className="p-5">
            <div className="flex items-center gap-2 text-lime">
              <CheckCircle2 className="size-4" aria-hidden="true" />
              <span className="micro text-lime">Mission accepted</span>
            </div>
            <dl className="mt-5 space-y-4">
              <ResultRow label="mission id" value={created.missionId} />
              <ResultRow label="bootstrap task" value={created.taskId} />
              <ResultRow label="grant id" value={created.grantId} />
            </dl>
            {created.artifacts && created.artifacts.length > 0 ? (
              <div className="mt-6 border-t border-line pt-4">
                <p className="micro mb-2">已绑定附件 {created.artifacts.length} 个</p>
                <ul className="space-y-2">
                  {created.artifacts.map(artifact => (
                    <li key={artifact.id} className="flex flex-wrap items-center justify-between gap-2 border border-line bg-ink-2 px-3 py-2 text-xs">
                      <span className="min-w-0 truncate text-paper">{artifact.filename}</span>
                      <span className="mono text-[10px] text-faint">{formatBytes(artifact.size)} · SHA-256 {artifact.sha256.slice(0, 12)}…</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="mt-6 flex flex-wrap gap-2">
              <Link to={`/missions/${created.missionId}`} className="btn btn-outline">进入项目</Link>
              <Link to="/missions" className="btn btn-ghost">项目列表</Link>
            </div>
          </Panel>
          <Panel className="p-5">
            <p className="micro mb-3">授权范围 scope</p>
            <pre className="code-block max-h-72">{JSON.stringify(created.scope, null, 2)}</pre>
            <p className="mt-3 text-xs text-muted">
              {form.targetType === 'attachment' ? '附件模式使用 allowAll 网络 scope；所有外联仍经 proxy 审计。' : 'scope 由目标推导；如需扩展范围，请在高级选项里补充域后缀、IP 或 URL 前缀，或走审批流程。'}
            </p>
          </Panel>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1500px]">
      <PageHeader
        index="01 / 项目 / 新建"
        title={<>发起项目</>}
        description="填写授权目标与成功标准。创建后项目先进入 pending，由 readiness 提升为 ready 并被 Worker 领取；所有人工操作都有审计。"
        aside={
          <div className="border border-line bg-panel px-5 py-4 text-left">
            <div className="flex items-center gap-2 text-lime">
              <Crosshair className="size-4" aria-hidden="true" />
              <span className="micro text-lime">目标预览</span>
            </div>
            <p className="mono mt-2 max-w-[300px] break-all text-xs text-paper">{targetPreview}</p>
            <p className="mt-2 text-[10px] text-faint">{form.targetType === 'attachment' ? '附件' : form.targetType ? form.targetType.toUpperCase() : '未选择类型'} · 仅在授权范围内测试</p>
          </div>
        }
      />

      <div className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-8">
          <section aria-labelledby="target-section">
            <div className="mb-4 flex items-center gap-3">
              <span className="mono text-[10px] tracking-[0.2em] text-lime">01</span>
              <h2 id="target-section" className="display text-[12px] tracking-[0.16em] text-paper">目标与授权</h2>
              <span className="h-px flex-1 bg-line" aria-hidden="true" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="block">
                <span id="target-type-label" className="micro mb-2 block text-muted">目标类型</span>
                <div role="radiogroup" aria-labelledby="target-type-label" className="inline-flex border border-line bg-ink-2 p-0.5">
                  {(['url', 'ip', 'domain', 'attachment'] as TargetChoice[]).map(type => {
                    const active = form.targetType === type;
                    return (
                      <button
                        key={type}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={cn('px-3 py-1.5 text-[10px] uppercase tracking-[0.1em] transition-colors', active ? 'bg-paper' : 'hover:bg-surface-2')}
                        style={{ color: active ? 'var(--color-ink)' : 'var(--color-muted)' }}
                        onClick={() => update('targetType', type)}
                      >
                        {type === 'attachment' ? '纯附件' : type.toUpperCase()}
                      </button>
                    );
                  })}
                </div>
                {errors.targetType ? <span className="mt-1.5 block text-xs text-ember">{errors.targetType}</span> : null}
                {!errors.targetType ? <span className="mt-1.5 block text-xs text-faint">{form.targetType === 'attachment' ? '上传指定的附件文件' : '先选择类型，再填写真实目标 Host。'}</span> : null}
              </div>
              <Field label="项目名称" hint="留空时后端自动生成。">
                <Input value={form.name} onChange={event => update('name', event.target.value)} placeholder="例如：LAN ctf-range 全量打靶" />
              </Field>
              {form.targetType === 'attachment' ? (
                <div className="sm:col-span-2 border border-line bg-panel px-3 py-2.5">
                  <p className="micro text-lime">附件模式</p>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted">
                    以附件为核心输入进行逆向/分析；仍可向外发起网络请求，全部经 proxy 审计。
                  </p>
                </div>
              ) : (
                <div className="sm:col-span-2">
                  <Field
                    label={form.targetType === 'url' ? '目标 URL' : form.targetType === 'ip' ? '目标 IP' : form.targetType === 'domain' ? '目标域名' : '目标值'}
                    error={errors.targetValue}
                    hint="请填写真实目标 host"
                  >
                    <Input
                      value={form.targetValue}
                      onChange={event => update('targetValue', event.target.value)}
                      placeholder={form.targetType === 'url' ? 'http://192.168.79.165:64280' : form.targetType === 'ip' ? '192.168.79.165' : form.targetType === 'domain' ? 'app.example.com' : '请先选择目标类型'}
                      disabled={!form.targetType}
                      className={errors.targetValue ? 'field-error' : ''}
                    />
                  </Field>
                </div>
              )}
            </div>
          </section>

          <section aria-labelledby="objective-section">
            <div className="mb-4 flex items-center gap-3">
              <span className="mono text-[10px] tracking-[0.2em] text-lime">02</span>
              <h2 id="objective-section" className="display text-[12px] tracking-[0.16em] text-paper">目标与成功标准</h2>
              <span className="h-px flex-1 bg-line" aria-hidden="true" />
            </div>
            <Field label="项目目标 objective" error={errors.objective} hint={`${objectiveLength} / 至少 10 字符 · 写清范围、漏洞类别与成功条件`}>
              <Textarea
                value={form.objective}
                onChange={event => update('objective', event.target.value)}
                placeholder="例如：对授权靶场进行完整安全测试，覆盖认证/授权、注入、SSRF、文件读取与命令执行，获取并报告全部 flag；每个发现需包含 baseline 与 proof。"
                rows={5}
                className={errors.objective ? 'field-error' : ''}
              />
            </Field>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="优先级" hint="0 最低，1 最高">
                <SpringSelect
                  value={form.priority}
                  onChange={value => update('priority', value)}
                  ariaLabel="项目优先级"
                  fullWidth
                  size="field"
                  options={[{ value: '0', label: '0.0 低' }, { value: '0.5', label: '0.5 标准' }, { value: '1', label: '1.0 高' }]}
                />
              </Field>
              <Field label="方法论（可选）">
                <Input value={form.methodology} onChange={event => update('methodology', event.target.value)} placeholder="例如：OWASP WSTG" />
              </Field>
            </div>
          </section>

          <section aria-labelledby="attachments-section">
            <div className="mb-4 flex items-center gap-3">
              <span className="mono text-[10px] tracking-[0.2em] text-lime">03</span>
              <h2 id="attachments-section" className="display text-[12px] tracking-[0.16em] text-paper">附件{form.targetType === 'attachment' ? '（必填）' : '（可选）'}</h2>
              <span className="h-px flex-1 bg-line" aria-hidden="true" />
              <span className="mono text-[10px] text-faint">{files.length} / 20</span>
              {form.targetType === 'attachment' ? <span className="text-[10px] uppercase tracking-[0.1em] text-ember">必填</span> : null}
            </div>
            <div
              role="button"
              tabIndex={0}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInputRef.current?.click(); } }}
              onClick={() => { if (!pending) fileInputRef.current?.click(); }}
              onDragOver={event => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={event => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files); }}
              className={`flex flex-col items-center justify-center border border-dashed px-4 py-6 text-center transition-colors ${dragging ? 'border-lime bg-lime/5' : 'border-line bg-panel hover:border-lime/35'}`}
            >
              <UploadCloud className={`size-6 ${dragging ? 'text-lime' : 'text-faint'}`} aria-hidden="true" />
              <p className="mt-2 text-xs text-paper">拖拽 APK / ELF / SO / DEX / JAR / JS 到这里，或点击选择</p>
              <p className="mt-1 text-[10px] text-faint">可多选，最多 20 个 · 单文件最大 2GB · 与项目在同一次请求中创建</p>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={event => { if (event.target.files) addFiles(event.target.files); event.target.value = ''; }}
              />
            </div>
            {errors.attachments ? <p className="mt-2 text-xs text-ember">{errors.attachments}</p> : null}
            {fileError ? <p className="mt-2 text-xs text-amber-200">{fileError}</p> : null}
            {files.length > 0 ? (
              <ul className="mt-3 divide-y divide-line border border-line bg-ink-2/50">
                {files.map((file, index) => (
                  <li key={`${file.name}-${file.size}-${index}`} className="flex items-center gap-2 px-3 py-2 text-xs">
                    <FileArchive className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-paper">{file.name}</span>
                    <span className="mono shrink-0 text-[10px] text-faint">{formatBytes(file.size)}</span>
                    <button type="button" className="shrink-0 text-faint hover:text-ember" onClick={() => removeFile(index)} disabled={pending} aria-label={`移除 ${file.name}`}>
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {pending && files.length > 0 ? (
              <div className="mt-3 border border-line bg-panel px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-paper">创建中 · 上传附件 {progress}%</span>
                  <Button variant="ghost" onClick={() => abortRef.current?.abort()}>取消</Button>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden bg-line"><div className="h-full bg-lime transition-[width] duration-150" style={{ width: `${progress}%` }} /></div>
              </div>
            ) : null}
          </section>

          <section aria-labelledby="limits-section">
            <button
              type="button"
              className="mb-4 flex w-full items-center gap-3 text-left"
              aria-expanded={advanced}
              onClick={() => setAdvanced(value => !value)}
            >
              <span className="mono text-[10px] tracking-[0.2em] text-lime">04</span>
              <h2 id="limits-section" className="display text-[12px] tracking-[0.16em] text-paper">高级选项</h2>
              <SlidersHorizontal className="size-3.5 text-faint" aria-hidden="true" />
              <span className="h-px flex-1 bg-line" aria-hidden="true" />
              <span className="text-[10px] uppercase tracking-[0.12em] text-faint">{advanced ? '收起' : '展开'}</span>
            </button>
            {advanced ? (
              <div className="space-y-4 border border-line bg-panel p-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="步数上限 maxSteps" error={errors.maxSteps} hint="0 表示不限（当前默认采用 ARTEX 策略）。">
                    <Input type="number" min={0} value={form.maxSteps} onChange={event => update('maxSteps', event.target.value)} className={errors.maxSteps ? 'field-error' : ''} />
                  </Field>
                  <Field label="墙钟上限 maxWallClockMs" error={errors.maxWallClockMs} hint="毫秒；0 表示不限。默认由运行时策略控制。">
                    <Input type="number" min={0} value={form.maxWallClockMs} onChange={event => update('maxWallClockMs', event.target.value)} className={errors.maxWallClockMs ? 'field-error' : ''} />
                  </Field>
                </div>
                {form.targetType === 'attachment' ? (
                  <p className="text-xs leading-relaxed text-muted">
                    纯附件项目使用 allowAll 网络 scope，所有外联经 proxy 审计；无需填写 scope 扩展。
                  </p>
                ) : (
                  <>
                    <p className="micro">scope 扩展 · 留空表示仅目标本身</p>
                    <div className="grid gap-4 sm:grid-cols-3">
                      <Field label="域后缀" hint="逗号或换行分隔">
                        <Textarea value={form.domainSuffixes} onChange={event => update('domainSuffixes', event.target.value)} rows={3} placeholder="example.com" />
                      </Field>
                      <Field label="IP" hint="逗号或换行分隔">
                        <Textarea value={form.ips} onChange={event => update('ips', event.target.value)} rows={3} placeholder="10.0.0.0/24（支持 CIDR）" />
                      </Field>
                      <Field label="URL 前缀" hint="逗号或换行分隔">
                        <Textarea value={form.urlPrefixes} onChange={event => update('urlPrefixes', event.target.value)} rows={3} placeholder="http://192.168.79.165/" />
                      </Field>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <p className="text-xs text-faint">{form.targetType === 'attachment' ? '纯附件项目允许任意外联，仍经 proxy 审计。' : '默认只对目标本身授权。需要扩展范围时展开高级选项，扩展会进入 grant scope 并受审计。'}</p>
            )}
          </section>

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
            <Button variant="primary" disabled={pending} onClick={() => void submit()} icon={<Target className="size-3.5" aria-hidden="true" />}>
              {pending ? '创建中…' : '创建项目'}
            </Button>
            <Button variant="ghost" onClick={() => navigate('/missions')}>取消</Button>
            <span className="text-[10px] uppercase tracking-[0.12em] text-faint">创建后自动审计 · 可随时暂停</span>
          </div>
          {serverError ? <ErrorState error={serverError} /> : null}
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <Panel className="p-5">
            <div className="flex items-center gap-2">
              <Sparkles className="size-3.5 text-lime" aria-hidden="true" />
              <span className="micro text-lime">项目简报</span>
            </div>
            <p className="display mt-4 text-[clamp(1.4rem,2.6vw,2.2rem)] leading-tight text-paper">
              {form.name.trim() || '未命名行动'}
            </p>
            <p className="mono mt-2 break-all text-xs text-muted">{targetPreview}</p>
            <p className="mt-4 line-clamp-4 text-xs leading-relaxed text-muted">{form.objective.trim() || '尚未填写目标。建议写清授权范围、漏洞类别与成功条件，便于 Planner 拆分任务。'}</p>
            <dl className="mt-5 space-y-2 border-t border-line pt-4 text-xs">
              <div className="flex justify-between gap-3"><dt className="text-faint">优先级</dt><dd className="mono text-paper">{form.priority}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-faint">授权范围</dt><dd className="mono text-paper">{form.targetType === 'attachment' ? 'allowAll' : 'target + extras'}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-faint">附件</dt><dd className="mono text-paper">{files.length} 个</dd></div>
            </dl>
          </Panel>
          <div className="border border-line p-4 text-[11px] leading-relaxed text-faint">
            前端只调用冻结的 v1 契约（POST /api/missions）。创建失败时请检查字段校验；409/400 会返回错误信封。
          </div>
        </aside>
      </div>
    </div>
  );
}

function ResultRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 border-b border-line pb-3">
      <dt className="w-36 shrink-0 text-[10px] uppercase tracking-[0.12em] text-faint">{label}</dt>
      <dd className="mono min-w-0 flex-1 break-all text-xs text-paper">{value}</dd>
      <CopyButton value={value} />
    </div>
  );
}
