import { useEffect, useState } from 'react';
import { Button, Field, Input, Panel } from '../components/ui';
import { DetailPanel } from '../components/detail-panel';
import { SpringSelect } from '../components/spring-select';
import { PageHeader } from '../components/shell';
import { SettingsNav } from '../components/settings-nav';
import { api } from '../lib/api';
import type { ArtifactGcResult, RuntimeSettings } from '../lib/types';

export function SettingsRuntime() {
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [gcOpen, setGcOpen] = useState(false);
  const [gcDays, setGcDays] = useState(7);
  const [gcBusy, setGcBusy] = useState(false);
  const [gcResult, setGcResult] = useState<ArtifactGcResult | null>(null);
  const [gcError, setGcError] = useState('');
  useEffect(() => { void api.getRuntimeSettings().then(result => setSettings(result.settings)).catch(error => setMessage(String(error))); }, []);

  if (!settings) return <p className="text-sm text-muted">{message || '加载设置…'}</p>;
  const update = (key: keyof RuntimeSettings, value: unknown) => setSettings({ ...settings, [key]: value } as RuntimeSettings);
  const runGc = async (): Promise<void> => {
    setGcBusy(true);
    setGcError('');
    try {
      setGcResult(await api.gcArtifacts(gcDays));
    } catch (error) {
      setGcError(error instanceof Error ? error.message : String(error));
    } finally {
      setGcBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    setBusy(true); setMessage('');
    try {
      const values = Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'version'));
      const result = await api.patchRuntimeSettings(values, settings.version);
      setSettings(result.settings);
      setMessage('已保存；对下一个任务/下一次 Planner 生效。');
    } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
  };
  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-5">
      <PageHeader
        compact
        index="05 / 设置 / 运行时参数"
        title="运行时参数"
        description=""
        actions={<Button variant="outline" onClick={() => setGcOpen(true)}>Artifact 清理</Button>}
        aside={
          <div className="border border-line bg-panel px-4 py-3 text-left">
            <p className="micro">ADMIN PARAMETERS</p>
            <p className="mt-1 text-[10px] text-muted">保存后对下一个任务 / 下一次 Planner 生效</p>
          </div>
        }
      />
      <SettingsNav />
      <Panel className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
        <Field label="Planner 最大开放任务"><Input type="number" min={1} max={5} value={settings['planner.maxOpenTasks']} onChange={e => update('planner.maxOpenTasks', Number(e.target.value))} /></Field>
        <Field label="Planner 并行任务"><Input type="number" min={1} max={3} value={settings['planner.parallelTasks']} onChange={e => update('planner.parallelTasks', Number(e.target.value))} /></Field>
        <Field label="Finding review">
          <SpringSelect value={settings['worker.findingReviewMode']} onChange={value => update('worker.findingReviewMode', value)} ariaLabel="Finding review 模式" fullWidth size="field" options={[{ value: 'auto', label: 'auto' }, { value: 'manual', label: 'manual' }]} />
        </Field>
        <Field label="Summary / 补漏">
          <SpringSelect value={settings['worker.summaryEnabled'] ? '1' : '0'} onChange={value => update('worker.summaryEnabled', value === '1')} ariaLabel="Summary 与补漏开关" fullWidth size="field" options={[{ value: '1', label: 'enabled' }, { value: '0', label: 'disabled' }]} />
        </Field>
        <Field label="Summary 最大轮数">
          <Input type="number" min={1} max={5} value={settings['worker.summaryMaxRounds']} onChange={e => update('worker.summaryMaxRounds', Number(e.target.value))} />
        </Field>
        <Field label="补漏任务（可选）">
          <SpringSelect value={settings['worker.summaryFollowUpEnabled'] ? '1' : '0'} onChange={value => update('worker.summaryFollowUpEnabled', value === '1')} ariaLabel="补漏任务开关" fullWidth size="field" options={[{ value: '0', label: '仅报告（默认）' }, { value: '1', label: '允许补漏' }]} />
        </Field>
        <Field label="补漏任务上限">
          <Input type="number" min={0} max={1} value={settings['worker.summaryMaxFollowUps']} onChange={e => update('worker.summaryMaxFollowUps', Number(e.target.value))} />
        </Field>
        <Field label="请求去重">
          <SpringSelect value={settings['worker.requestDedupeMode']} onChange={value => update('worker.requestDedupeMode', value)} ariaLabel="请求去重模式" fullWidth size="field" options={[{ value: 'warn', label: 'warn' }, { value: 'off', label: 'off' }]} />
        </Field>
        <Field label="去重 TTL（分钟）"><Input type="number" min={1} max={1440} value={settings['worker.requestDedupeTtlMinutes']} onChange={e => update('worker.requestDedupeTtlMinutes', Number(e.target.value))} /></Field>
        <Field label="Planner frontier"><SpringSelect value={settings['planner.frontierEnabled'] ? '1' : '0'} onChange={value => update('planner.frontierEnabled', value === '1')} ariaLabel="Planner frontier 开关" fullWidth size="field" options={[{ value: '1', label: 'enabled' }, { value: '0', label: 'disabled' }]} /></Field>
        <Field label="Mission context"><SpringSelect value={settings['worker.missionContextEnabled'] ? '1' : '0'} onChange={value => update('worker.missionContextEnabled', value === '1')} ariaLabel="Mission context 开关" fullWidth size="field" options={[{ value: '1', label: 'enabled' }, { value: '0', label: 'disabled' }]} /></Field>
        <Field label="跨任务轨迹检索"><SpringSelect value={settings['worker.traceSearchEnabled'] ? '1' : '0'} onChange={value => update('worker.traceSearchEnabled', value === '1')} ariaLabel="跨任务轨迹检索开关" fullWidth size="field" options={[{ value: '1', label: 'enabled' }, { value: '0', label: 'disabled' }]} /></Field>
      </Panel>
      {message ? <p className="text-xs text-muted">{message}</p> : null}
      <Button onClick={() => void save()} disabled={busy}>{busy ? '保存中…' : '保存设置'}</Button>

      <DetailPanel
        open={gcOpen}
        onOpenChange={setGcOpen}
        title="Artifact TTL 清理"
        description="管理维护操作：按 mtime 和创建时间清理超过保留期的样本文件与元数据。不要在任务/逆向 job 运行中执行。"
      >
        <div className="space-y-4">
          <Field label="保留天数" hint="1–365 天，默认 7 天；清理 artifacts 文件、空目录和过期数据库元数据。">
            <Input type="number" min={1} max={365} value={gcDays} onChange={event => setGcDays(Math.max(1, Math.min(365, Number(event.target.value) || 1)))} />
          </Field>
          <Button variant="danger" disabled={gcBusy} onClick={() => void runGc()}>{gcBusy ? '清理中…' : '执行 TTL 清理'}</Button>
          {gcError ? <p className="border border-ember/30 bg-ember/5 px-3 py-2 text-xs text-ember">{gcError}</p> : null}
          {gcResult ? (
            <div className="border border-lime/25 bg-lime/5 px-3 py-2.5 text-xs leading-relaxed text-paper">
              <p>cutoff：<span className="mono text-faint">{new Date(gcResult.cutoff).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</span></p>
              <p className="mt-1">已删除文件 <span className="mono text-lime">{gcResult.removedFiles}</span> 个 · 元数据 <span className="mono text-lime">{gcResult.removedArtifacts}</span> 条</p>
            </div>
          ) : null}
          <p className="text-[11px] leading-relaxed text-faint">
            license、IDA/JADX 安装文件不在 artifact volume 内，不会被清理。项目销毁仍会递归删除 /artifacts/&lt;missionId&gt;。
          </p>
        </div>
      </DetailPanel>
    </div>
  );
}
