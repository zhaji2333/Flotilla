import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { request } from 'undici';
import type { WorkerPluginConfig } from './config.js';

interface Artifact {
  id: string;
  sha256: string;
  size: number;
  filename: string;
  contentType: string;
  storagePath: string;
  taskId?: string | null;
}

interface ReverseJob {
  id: string;
  state: string;
  kind: string;
  result?: Record<string, unknown>;
  error?: string;
}

class ReverseClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly missionApiUrl: string;
  private readonly missionApiToken: string;

  constructor(private readonly config: WorkerPluginConfig) {
    this.baseUrl = config.reverseServiceUrl ?? 'http://reverse:9402';
    this.token = config.reverseServiceToken ?? 'dev-reverse-token';
    this.missionApiUrl = config.missionApiUrl ?? '';
    this.missionApiToken = config.missionApiToken ?? '';
  }

  private async service(path: string, body?: Record<string, unknown>, method: 'GET' | 'POST' = 'POST'): Promise<Record<string, unknown>> {
    const response = await request(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-reverse-token': this.token },
      ...(body ? { body: JSON.stringify(body) } : {}),
      headersTimeout: 30_000,
      bodyTimeout: 120_000,
    });
    const text = await response.body.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const message = typeof parsed === 'object' && parsed && 'error' in parsed ? String((parsed as { error?: unknown }).error) : text.slice(0, 500);
      throw new Error(`reverse service HTTP ${response.statusCode}: ${message}`);
    }
    return (parsed ?? {}) as Record<string, unknown>;
  }

  async listArtifacts(): Promise<Artifact[]> {
    if (!this.missionApiUrl || !this.missionApiToken) throw new Error('mission API URL/token is not configured');
    const response = await request(`${this.missionApiUrl}/api/missions/${encodeURIComponent(this.config.missionId)}/artifacts`, {
      headers: { authorization: `Bearer ${this.missionApiToken}` },
      headersTimeout: 20_000,
      bodyTimeout: 30_000,
    });
    const text = await response.body.text();
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`artifact list HTTP ${response.statusCode}: ${text.slice(0, 300)}`);
    const parsed = JSON.parse(text) as { artifacts?: Artifact[] };
    return Array.isArray(parsed.artifacts) ? parsed.artifacts : [];
  }

  async resolveArtifact(artifactId?: string): Promise<Artifact> {
    const artifacts = await this.listArtifacts();
    if (artifactId) {
      const found = artifacts.find(artifact => artifact.id === artifactId);
      if (!found) throw new Error(`artifact ${artifactId} not found in this mission`);
      return found;
    }
    const apk = artifacts.find(artifact => /\.apk$/i.test(artifact.filename) || artifact.contentType === 'application/vnd.android.package-archive');
    if (!apk) throw new Error('no APK artifact found; pass artifact_id or upload one first');
    return apk;
  }

  async startJob(kind: 'apk' | 'ida', artifact: Artifact): Promise<string> {
    const job = await this.service('/v1/jobs', {
      kind,
      artifactId: artifact.id,
      storagePath: artifact.storagePath,
      sha256: artifact.sha256,
      missionId: this.config.missionId,
      taskId: this.config.taskId,
    });
    if (typeof job.jobId !== 'string') throw new Error('reverse service returned no jobId');
    return job.jobId;
  }

  async wait(jobId: string): Promise<ReverseJob> {
    const timeoutMs = Math.max(30_000, Number(process.env.REVERSE_TOOL_TIMEOUT_MS || 420_000));
    const started = Date.now();
    for (;;) {
      const job = await this.service(`/v1/jobs/${jobId}`, undefined, 'GET') as unknown as ReverseJob;
      if (job.state === 'done' || job.state === 'failed') return job;
      if (Date.now() - started > timeoutMs) throw new Error(`reverse job ${jobId} timed out in state ${job.state}`);
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
  }

  async search(jobId: string, query: string): Promise<Record<string, unknown>> {
    return await this.service(`/v1/jobs/${jobId}/search`, { query });
  }
}

function textOnly(text: string): { text: string } {
  return { text };
}

export function buildReverseTools(deps: { config: WorkerPluginConfig }) {
  const client = new ReverseClient(deps.config);

  const artifactList = defineTool({
    name: 'artifact_list',
    description: 'List downloadable input artifacts uploaded to this mission (APK/ELF/JS). Use an artifact_id with reverse_apk.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: String((value as { text: string }).text) }],
    },
    timeoutMs: 45_000,
    isConcurrencySafe: () => false,
    async execute() {
      const artifacts = await client.listArtifacts();
      const text = artifacts.length
        ? artifacts.map(artifact => `[${artifact.id}] ${artifact.filename} size=${artifact.size} sha256=${artifact.sha256}`).join('\n')
        : 'no uploaded artifacts';
      return textOnly(text);
    },
  });

  const reverseApk = defineTool({
    name: 'reverse_apk',
    description: 'Run offline JADX + ASC analysis over an uploaded APK (and detect React Native/Hermes assets). ' +
      'Returns a bounded summary and a job_id; use reverse_search for paged code/string search. The APK is never executed.',
    parameters: {
      artifact_id: { type: 'string', description: 'Artifact id from artifact_list; optional when exactly one APK exists.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: String((value as { text: string }).text) }],
    },
    timeoutMs: 480_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const artifact = await client.resolveArtifact(args.artifact_id ? String(args.artifact_id) : undefined);
      const jobId = await client.startJob('apk', artifact);
      const job = await client.wait(jobId);
      if (job.state === 'failed') throw new Error(`reverse job ${jobId} failed: ${job.error ?? 'unknown error'}`);
      const result = job.result ?? {};
      const text = JSON.stringify({ job_id: jobId, ...result }).slice(0, 40_000);
      return textOnly(text);
    },
  });

  const reverseIda = defineTool({
    name: 'reverse_ida',
    description: 'Run direct idalib analysis (no MCP/GUI) on an uploaded ELF/.so. Returns functions, exports, strings and bounded pseudocode, plus a job_id for reverse_search. ' +
      'Never execute the binary; analysis is offline.',
    parameters: {
      artifact_id: { type: 'string', description: 'Artifact id for an ELF/.so; optional when exactly one native artifact exists.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: String((value as { text: string }).text) }],
    },
    timeoutMs: 480_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const artifacts = await client.listArtifacts();
      const requested = args.artifact_id ? String(args.artifact_id) : '';
      const artifact = requested
        ? artifacts.find(item => item.id === requested)
        : artifacts.find(item => /\.(so|elf|dylib|bin)$/i.test(item.filename));
      if (!artifact) throw new Error('native artifact not found; upload an ELF/.so or pass artifact_id');
      const jobId = await client.startJob('ida', artifact);
      const job = await client.wait(jobId);
      if (job.state === 'failed') throw new Error(`IDA job ${jobId} failed: ${job.error ?? 'unknown error'}`);
      return textOnly(JSON.stringify({ job_id: jobId, ...job.result }).slice(0, 40_000));
    },
  });

  const reverseSearch = defineTool({
    name: 'reverse_search',
    description: 'Search the decompiled output of a completed reverse_apk job for a string (class, token, URL, API path). Returns bounded file/line matches.',
    parameters: {
      job_id: { type: 'string', required: true, description: 'job_id returned by reverse_apk.' },
      query: { type: 'string', required: true, description: 'Case-insensitive search string (max 200 chars).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: String((value as { text: string }).text) }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const result = await client.search(String(args.job_id ?? ''), String(args.query ?? ''));
      const text = JSON.stringify(result).slice(0, 30_000);
      return textOnly(text);
    },
  });

  return {
    tools: { artifactList, reverseApk, reverseIda, reverseSearch },
    dispose: async () => undefined,
  };
}

export type ReverseTools = ReturnType<typeof buildReverseTools>;
