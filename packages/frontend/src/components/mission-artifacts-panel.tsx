import { FileArchive, RefreshCw, ShieldAlert, UploadCloud, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, MAX_ARTIFACT_BYTES } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatBytes, formatShortDate } from '../lib/format';
import { useAsync } from '../lib/hooks';
import { canOperate } from '../lib/permissions';
import type { MissionArtifact } from '../lib/types';
import { useToast } from './toast';
import { Badge, Button, EmptyState, ErrorState, Panel, SectionLabel, Skeleton } from './ui';

const SAMPLE_EXTENSIONS = ['apk', 'so', 'elf', 'dex', 'jar', 'js'];

function extensionOf(filename: string): string {
  const index = filename.lastIndexOf('.');
  return index >= 0 ? filename.slice(index + 1).toLowerCase() : 'bin';
}

export function MissionArtifactsPanel({ missionId }: { missionId: string }) {
  const toast = useToast();
  const { user } = useAuth();
  const writable = canOperate(user);
  const artifacts = useAsync(() => api.listMissionArtifacts(missionId).then(result => result.artifacts), [missionId]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadName, setUploadName] = useState('');
  const [error, setError] = useState('');
  const [uploaded, setUploaded] = useState<MissionArtifact | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function upload(file: File): Promise<void> {
    if (!writable || uploading) return;
    setError('');
    setUploaded(null);
    const extension = extensionOf(file.name);
    if (!SAMPLE_EXTENSIONS.includes(extension)) {
      setError(`建议上传 APK / ELF / SO / DEX / JAR / JS 样本；当前扩展名 .${extension}，仍可尝试上传。`);
    }
    if (file.size === 0) {
      setError('文件为空，无法上传。');
      return;
    }
    if (file.size > MAX_ARTIFACT_BYTES) {
      setError(`文件过大（${formatBytes(file.size)}），最大 2GB。`);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setUploading(true);
    setUploadName(file.name);
    setProgress(0);
    try {
      const artifact = await api.uploadMissionArtifact(missionId, file, setProgress, controller.signal);
      setError('');
      setUploaded(artifact);
      toast('success', '样本上传成功。');
      await artifacts.refresh();
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setUploading(false);
      setProgress(0);
      setUploadName('');
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  function cancelUpload(): void {
    abortRef.current?.abort();
  }

  function onDrop(event: React.DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void upload(file);
  }

  const list = artifacts.data ?? [];
  const totalBytes = list.reduce((sum, artifact) => sum + artifact.size, 0);

  return (
    <div className="space-y-4">
      <Panel className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <SectionLabel index="样本" right={<span className="mono text-[10px] text-faint">{list.length} 个文件 · {formatBytes(totalBytes)}</span>}>样本 / Artifacts</SectionLabel>
            <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted">
              上传本地 APK、ELF、SO、DEX、JAR 或 JS 样本，作为当前项目的逆向输入；项目删除或 TTL 清理时会一并移除。
            </p>
          </div>
          <Button variant="outline" icon={<RefreshCw className="size-3.5" aria-hidden="true" />} onClick={artifacts.refresh}>刷新列表</Button>
        </div>

        {writable ? (
          <div
            role="button"
            tabIndex={0}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inputRef.current?.click(); } }}
            onClick={() => { if (!uploading) inputRef.current?.click(); }}
            onDragOver={event => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`mt-4 flex flex-col items-center justify-center border border-dashed px-4 py-6 text-center transition-colors ${dragging ? 'border-lime bg-lime/5' : 'border-line bg-ink-2/50 hover:border-lime/35'}`}
          >
            <UploadCloud className={`size-6 ${dragging ? 'text-lime' : 'text-faint'}`} aria-hidden="true" />
            <p className="mt-2 text-xs text-paper">拖拽样本到这里，或点击选择文件</p>
            <p className="mt-1 text-[10px] text-faint">APK / ELF / SO / DEX / JAR / JS · 单文件最大 2GB</p>
            <input
              ref={inputRef}
              type="file"
              accept=".apk,.so,.elf,.dex,.jar,.js,application/octet-stream"
              className="hidden"
              disabled={uploading}
              onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); }}
            />
          </div>
        ) : (
          <p className="mt-4 flex items-center gap-2 border border-line bg-ink-2/50 px-3 py-2.5 text-xs text-muted">
            <ShieldAlert className="size-3.5 text-faint" aria-hidden="true" />当前角色只读；上传样本需要 operator 或 admin。
          </p>
        )}

        {uploading ? (
          <div className="mt-3 border border-line bg-ink-2 px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 truncate text-xs text-paper">上传中 · {uploadName}</p>
              <Button variant="ghost" icon={<X className="size-3.5" aria-hidden="true" />} onClick={cancelUpload}>取消上传</Button>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden bg-line">
              <div className="h-full bg-lime transition-[width] duration-150" style={{ width: `${progress}%` }} />
            </div>
            <p className="mono mt-1 text-[10px] text-faint">{progress}%</p>
          </div>
        ) : null}

        {error ? <p className="mt-3 border border-amber-300/25 bg-amber-300/5 px-3 py-2 text-xs leading-relaxed text-amber-100/85">{error}</p> : null}
        {uploaded ? (
          <p className="mt-3 border border-lime/25 bg-lime/5 px-3 py-2 text-xs text-lime">
            已上传 {uploaded.filename} · {formatBytes(uploaded.size)} · SHA-256 {uploaded.sha256.slice(0, 12)}…
          </p>
        ) : null}
      </Panel>

      <Panel className="p-4">
        <div className="flex items-center justify-between gap-3">
          <SectionLabel index="列表">已上传样本</SectionLabel>
          <span className="mono text-[10px] text-faint">{list.length} 个文件</span>
        </div>
        {artifacts.loading ? (
          <div className="mt-3 space-y-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
        ) : artifacts.error ? (
          <div className="mt-3"><ErrorState error={artifacts.error} retry={artifacts.refresh} /></div>
        ) : list.length === 0 ? (
          <div className="mt-3"><EmptyState icon={<FileArchive className="size-6" aria-hidden="true" />} title="暂无上传样本" hint="上传 APK / ELF / SO / DEX / JAR / JS 后，创建手动任务时可选择这些样本。" /></div>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {list.map(artifact => (
              <li key={artifact.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <FileArchive className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
                    <span className="truncate text-xs text-paper">{artifact.filename}</span>
                    <Badge tone="muted">{extensionOf(artifact.filename).toUpperCase()}</Badge>
                  </div>
                  <p className="mono mt-1 text-[10px] text-faint">
                    {formatBytes(artifact.size)} · SHA-256 {artifact.sha256.slice(0, 12)}… · {formatShortDate(artifact.createdAt)}
                  </p>
                </div>
                <span className="mono text-[9px] text-faint">{artifact.id.slice(0, 8)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
