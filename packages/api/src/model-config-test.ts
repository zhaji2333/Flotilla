import http from 'node:http';
import https from 'node:https';
import { z } from 'zod';
import { getModelConfigResolved } from '@src-agent/control-plane';
import { normalizeUpstreamBase } from './model-proxy.js';

// ── Model config connection test ────────────────────────────
// Admin-only probe: sends one tiny chat completion so an operator can verify
// the gateway URL, provider key and model name before relying on the config.
// The key never leaves this process: it is not logged, echoed or returned.

const TEST_TIMEOUT_MS = Math.max(3_000, Number(process.env.MODEL_TEST_TIMEOUT_MS || 30_000));
const MAX_TOKENS = 512;
/** Thinking models spend part of the budget on reasoning before `content`. */
const PROBE_PROMPT = 'Reply with exactly: OK';

function httpUrl(name: string) {
  return z.string().min(1).max(500).superRefine((value, context) => {
    let parsed: URL;
    try {
      parsed = new URL(value.trim());
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${name} must be an absolute URL` });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${name} must be http(s)` });
    }
    if (!parsed.hostname) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${name} must include a hostname` });
    }
  });
}

export const ModelConfigTestSchema = z.object({
  /** Existing config whose stored key is reused when `apiKey` is omitted. */
  id: z.string().uuid().optional(),
  baseUrl: httpUrl('baseUrl').optional(),
  apiKey: z.string().min(1).max(8_000).optional(),
  modelName: z.string().trim().min(1).max(200).optional(),
  maxOutputTokens: z.number().int().positive().max(2_000_000).optional(),
}).strict().superRefine((value, context) => {
  if (!value.id) {
    if (!value.baseUrl) context.addIssue({ code: z.ZodIssueCode.custom, message: 'baseUrl is required', path: ['baseUrl'] });
    if (!value.modelName) context.addIssue({ code: z.ZodIssueCode.custom, message: 'modelName is required', path: ['modelName'] });
    if (!value.apiKey) context.addIssue({ code: z.ZodIssueCode.custom, message: 'apiKey is required for an unsaved config', path: ['apiKey'] });
  }
});

export type ModelConfigTestInput = z.infer<typeof ModelConfigTestSchema>;

export interface ModelConfigTestResult {
  ok: boolean;
  latencyMs: number;
  httpStatus: number | null;
  model: string | null;
  reply: string | null;
  usage: Record<string, unknown> | null;
  error: string | null;
  errorCode: string | null;
  traceId: string | null;
}

interface ProbeTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Removes the provider key from any upstream text before it reaches a client. */
export function redactSecret(text: string, secret: string | undefined): string {
  const trimmed = (secret ?? '').trim();
  if (trimmed.length < 8) return text;
  return text.split(trimmed).join('***');
}

/** Explains the most common gateway failures without guessing the model name. */
export function describeProbeFailure(httpStatus: number | null, errorCode: string, message: string): string {
  if (httpStatus === 401 || httpStatus === 403) {
    const suffix = errorCode ? ` (${errorCode})` : '';
    const detail = message.trim() || 'upstream rejected the credentials';
    return `鉴权/权限失败${suffix}：${detail}`;
  }
  if (httpStatus === 404) return `接口或模型不存在：${message.trim() || 'upstream returned 404'}`;
  if (httpStatus === 429) return `上游限流：${message.trim() || 'upstream returned 429'}`;
  if (httpStatus !== null && httpStatus >= 500) return `上游服务异常：${message.trim() || `upstream returned ${httpStatus}`}`;
  return message.trim() || '模型连接失败';
}

function probeBody(model: string, maxOutputTokens: number): string {
  return JSON.stringify({
    model,
    temperature: 0,
    max_tokens: Math.min(MAX_TOKENS, maxOutputTokens),
    stream: false,
    messages: [{ role: 'user', content: PROBE_PROMPT }],
  });
}

function postJson(target: URL, apiKey: string, body: string, timeoutMs: number):
Promise<{ status: number; text: string }> {
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'content-length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1_000_000) {
          response.destroy(new Error('probe response too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error(`model probe timed out after ${timeoutMs}ms`)));
    request.on('error', reject);
    request.end(body);
  });
}

/** Runs one minimal chat completion against the configured gateway. */
export async function testModelConfig(input: ModelConfigTestInput): Promise<ModelConfigTestResult> {
  let target: ProbeTarget;
  if (!input.id) {
    target = { baseUrl: input.baseUrl!, apiKey: input.apiKey!, model: input.modelName! };
  } else {
    const stored = await getModelConfigResolved(input.id);
    if (!stored) throw Object.assign(new Error('model config not found'), { status: 404 });
    target = {
      baseUrl: input.baseUrl ?? stored.baseUrl,
      apiKey: input.apiKey ?? stored.apiKey,
      model: input.modelName ?? stored.modelName,
    };
  }
  const startedAt = Date.now();
  const base = normalizeUpstreamBase(target.baseUrl);
  const url = new URL(`${base}/chat/completions`);
  const result: ModelConfigTestResult = {
    ok: false,
    latencyMs: 0,
    httpStatus: null,
    model: null,
    reply: null,
    usage: null,
    error: null,
    errorCode: null,
    traceId: null,
  };
  let text = '';
  try {
    const response = await postJson(url, target.apiKey, probeBody(target.model, input.maxOutputTokens ?? MAX_TOKENS), TEST_TIMEOUT_MS);
    result.latencyMs = Date.now() - startedAt;
    result.httpStatus = response.status;
    text = response.text;
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = null; }
    const choices = (parsed?.choices ?? null) as Array<{ message?: { content?: unknown; reasoning_content?: unknown } }> | null;
    const message = choices?.[0]?.message;
    const content = typeof message?.content === 'string' ? message.content : '';
    const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : '';
    result.model = typeof parsed?.model === 'string' ? parsed.model : null;
    result.usage = (parsed?.usage as Record<string, unknown> | undefined) ?? null;
    result.traceId = typeof parsed?.trace_id === 'string' ? parsed.trace_id : null;
    if (response.status >= 200 && response.status < 300) {
      // Some thinking models return only reasoning when the budget is tiny;
      // a 2xx with either field proves URL + key + model routing work.
      const answer = content.trim() || reasoning.trim();
      if (!answer) {
        result.error = '上游返回 2xx，但没有 content/reasoning_content；请确认模型名称与网关兼容';
        result.errorCode = 'EMPTY_COMPLETION';
        return result;
      }
      result.ok = true;
      result.reply = redactSecret(content.trim() || reasoning.trim(), target.apiKey).slice(0, 500);
      return result;
    }
    const errorCode = typeof parsed?.code === 'string' ? parsed.code : typeof parsed?.error === 'object' && parsed.error
      ? String((parsed.error as Record<string, unknown>).code ?? '') : '';
    const upstreamMessage = typeof parsed?.message === 'string'
      ? parsed.message
      : typeof parsed?.error === 'string'
        ? parsed.error
        : text.slice(0, 400);
    result.errorCode = errorCode || null;
    result.traceId = typeof parsed?.traceId === 'string' ? parsed.traceId : result.traceId;
    result.error = redactSecret(describeProbeFailure(response.status, errorCode, upstreamMessage), target.apiKey);
    return result;
  } catch (error) {
    result.latencyMs = Date.now() - startedAt;
    const message = redactSecret(String(error instanceof Error ? error.message : error), target.apiKey);
    const timedOut = /timed out/i.test(message);
    result.error = timedOut ? `连接超时（>${TEST_TIMEOUT_MS}ms）：${message}` : `无法连接模型网关：${message}`;
    result.errorCode = timedOut ? 'TIMEOUT' : 'NETWORK';
    return result;
  }
}
