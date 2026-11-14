import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page, type Request as PlaywrightRequest } from 'playwright';
import type { BrowserServiceConfig } from './config.js';
import { ArtifactStore, type StoredArtifact } from './artifact-store.js';
import { assertNavigableUrl, isSafeSelector } from './url-policy.js';
import { extractCandidates, inlineSourceMap, isJavaScriptResource, isSourceMapResource, sourceMapDirective } from './network.js';

export interface NetworkEvent {
  seq: number;
  method: string;
  url: string;
  status: number;
  resourceType: string;
  mimeType: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
  responseHeaders: Record<string, string>;
  responseBody: string;
  responseBodyTruncated: boolean;
  artifact: StoredArtifact | null;
  error: string | null;
}

interface Session {
  id: string;
  missionId: string;
  taskId: string;
  context: BrowserContext;
  page: Page;
  events: NetworkEvent[];
  seq: number;
  createdAt: number;
  lastUsedAt: number;
  closing: boolean;
}

export interface SessionView {
  sessionId: string;
  missionId: string;
  taskId: string;
  url: string;
  title: string;
  createdAt: string;
}

export interface ActInput {
  action: 'click' | 'fill' | 'press' | 'select';
  selector?: string;
  text?: string;
  role?: string;
  name?: string;
  value?: string;
  key?: string;
}

const RESOURCE_TEXT_TYPES = /(?:text\/|application\/(?:json|javascript|xml|xhtml|x-www-form-urlencoded|graphql))/i;

export class BrowserManager {
  private browser: Browser | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly artifactStore: ArtifactStore;
  private reaper: NodeJS.Timeout | null = null;

  constructor(private readonly config: BrowserServiceConfig) {
    this.artifactStore = new ArtifactStore(config.artifactsDir);
    this.reaper = setInterval(() => { void this.reapIdleSessions(); }, Math.min(60_000, Math.max(5_000, config.sessionTtlMs / 4)));
    this.reaper.unref();
  }

  async createSession(input: { missionId: string; taskId: string }): Promise<SessionView> {
    if (this.sessions.size >= this.config.maxContexts) throw new Error('browser context limit reached');
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      serviceWorkers: 'block',
      acceptDownloads: false,
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: {
        'X-SRC-Mission-Id': input.missionId,
        'X-SRC-Task-Id': input.taskId,
      },
    });
    const page = await context.newPage();
    const session: Session = {
      id: randomUUID(),
      missionId: input.missionId,
      taskId: input.taskId,
      context,
      page,
      events: [],
      seq: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      closing: false,
    };
    this.sessions.set(session.id, session);
    this.observe(session);
    return await this.view(session);
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    const args = [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-default-apps',
    ];
    if (this.config.proxyUrl) {
      args.push(`--proxy-server=${this.config.proxyUrl}`, '--proxy-bypass-list=<-loopback>');
    }
    this.browser = await chromium.launch({
      headless: true,
      args,
      ...(this.config.chromiumPath ? { executablePath: this.config.chromiumPath } : {}),
    });
    return this.browser;
  }

  private observe(session: Session): void {
    const pending = new Map<PlaywrightRequest, { requestHeaders: Record<string, string>; requestBody: string }>();
    session.page.on('request', request => {
      pending.set(request, {
        requestHeaders: request.headers(),
        requestBody: request.postData()?.slice(0, 8_000) ?? '',
      });
    });
    session.page.on('response', response => {
      void this.captureResponse(session, response.request(), response, pending.get(response.request()));
    });
  }

  private async captureResponse(
    session: Session,
    request: PlaywrightRequest,
    response: Awaited<ReturnType<Page['goto']>> extends never ? never : import('playwright').Response,
    requestInfo: { requestHeaders: Record<string, string>; requestBody: string } | undefined,
  ): Promise<void> {
    try {
      const contentType = String(response.headers()['content-type'] ?? '');
      let body = '';
      let truncated = false;
      let artifact: StoredArtifact | null = null;
      let raw: Buffer | null = null;
      if (RESOURCE_TEXT_TYPES.test(contentType) || isJavaScriptResource(response.url(), request.resourceType())) {
        try {
          raw = await response.body();
        } catch {
          raw = null;
        }
        if (raw) {
          if (raw.length > this.config.maxBodyBytes) {
            raw = raw.subarray(0, this.config.maxBodyBytes);
            truncated = true;
          }
          body = raw.toString('utf8');
        }
      }
      if (raw) {
        const filename = (() => {
          try { return new URL(response.url()).pathname.split('/').pop() || 'body'; } catch { return 'body'; }
        })();
        artifact = await this.artifactStore.put(session.missionId, session.taskId, raw, filename).catch(() => null);
      }
      const event: NetworkEvent = {
        seq: ++session.seq,
        method: request.method(),
        url: response.url(),
        status: response.status(),
        resourceType: request.resourceType(),
        mimeType: contentType,
        requestHeaders: requestInfo?.requestHeaders ?? request.headers(),
        requestBody: requestInfo?.requestBody ?? '',
        responseHeaders: response.headers(),
        responseBody: body.slice(0, this.config.maxBodyBytes),
        responseBodyTruncated: truncated,
        artifact,
        error: null,
      };
      session.events.push(event);
      if (session.events.length > this.config.maxNetworkEvents) session.events.shift();
      session.lastUsedAt = Date.now();
    } catch (error) {
      const event: NetworkEvent = {
        seq: ++session.seq,
        method: request.method(),
        url: response.url(),
        status: response.status(),
        resourceType: request.resourceType(),
        mimeType: String(response.headers()['content-type'] ?? ''),
        requestHeaders: requestInfo?.requestHeaders ?? {},
        requestBody: requestInfo?.requestBody ?? '',
        responseHeaders: response.headers(),
        responseBody: '',
        responseBodyTruncated: false,
        artifact: null,
        error: String(error),
      };
      session.events.push(event);
      if (session.events.length > this.config.maxNetworkEvents) session.events.shift();
    }
  }

  private getSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session || session.closing) throw new Error('browser session not found');
    session.lastUsedAt = Date.now();
    return session;
  }

  private async view(session: Session): Promise<SessionView> {
    return {
      sessionId: session.id,
      missionId: session.missionId,
      taskId: session.taskId,
      url: session.page.url(),
      title: await session.page.title().catch(() => ''),
      createdAt: new Date(session.createdAt).toISOString(),
    };
  }

  async navigate(id: string, rawUrl: string): Promise<SessionView & { status: number | null }> {
    const session = this.getSession(id);
    const url = assertNavigableUrl(rawUrl);
    const response = await session.page.goto(url.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: this.config.navigationTimeoutMs,
    }).catch(error => {
      if (String(error).includes('Timeout')) return null;
      throw error;
    });
    await new Promise(resolve => setTimeout(resolve, 600));
    return { ...(await this.view(session)), status: response?.status() ?? null };
  }

  async snapshot(id: string): Promise<unknown> {
    const session = this.getSession(id);
    const snapshot = await session.page.evaluate((maxChars: number) => {
      const text = (document.body?.innerText ?? '').replace(/\s+\n/g, '\n').slice(0, maxChars);
      const forms = [...document.forms].slice(0, 40).map(form => ({
        action: form.getAttribute('action') ?? '',
        method: (form.getAttribute('method') ?? 'get').toUpperCase(),
        inputs: [...form.elements].slice(0, 50).map(element => ({
          tag: element.tagName.toLowerCase(),
          name: element.getAttribute('name') ?? '',
          type: element.getAttribute('type') ?? '',
          value: element instanceof HTMLInputElement ? element.value.slice(0, 200) : '',
        })),
      }));
      const links = [...document.links].slice(0, 200).map(link => ({
        href: link.href,
        text: (link.textContent ?? '').trim().slice(0, 200),
      }));
      return { title: document.title, url: location.href, text, forms, links };
    }, this.config.maxSnapshotChars);
    return { ...(await this.view(session)), ...snapshot };
  }

  async act(id: string, input: ActInput): Promise<{ url: string; title: string; action: string }> {
    const session = this.getSession(id);
    const page = session.page;
    const timeout = this.config.actionTimeoutMs;
    const target = input.selector
      ? page.locator(input.selector).first()
      : input.role
        ? page.getByRole(input.role as never, input.name ? { name: input.name } : {}).first()
        : input.text
          ? page.getByText(input.text, { exact: false }).first()
          : null;
    if (!target) throw new Error('selector, text or role is required');
    if (!isSafeSelector(input.selector) && !input.text && !input.role) throw new Error('invalid selector');
    if (input.action === 'click') {
      await target.click({ timeout });
    } else if (input.action === 'fill') {
      await target.fill(String(input.value ?? ''), { timeout });
    } else if (input.action === 'press') {
      await target.press(String(input.key ?? 'Enter'), { timeout });
    } else if (input.action === 'select') {
      await target.selectOption(String(input.value ?? ''), { timeout });
    } else {
      throw new Error(`unsupported action: ${String(input.action)}`);
    }
    await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 400));
    return { url: page.url(), title: await page.title().catch(() => ''), action: input.action };
  }

  async eval(id: string, expression: string): Promise<unknown> {
    if (!this.config.evalEnabled) throw new Error('browser_eval is disabled by configuration');
    if (typeof expression !== 'string' || !expression.trim() || expression.length > 20_000) throw new Error('invalid expression');
    const session = this.getSession(id);
    return await session.page.evaluate(expression);
  }

  network(id: string, since = 0, limit = 50): { events: Array<Record<string, unknown>>; next: number } {
    const session = this.getSession(id);
    const max = Math.max(1, Math.min(200, Number(limit) || 50));
    const events = session.events.filter(event => event.seq > since).slice(-max).map(event => this.publicEvent(event));
    return { events, next: session.seq };
  }

  chunks(id: string): { chunks: Array<Record<string, unknown>>; sourceMaps: Array<Record<string, unknown>>; candidates: string[] } {
    const session = this.getSession(id);
    const chunks: Array<Record<string, unknown>> = [];
    const sourceMaps: Array<Record<string, unknown>> = [];
    const candidates = new Set<string>();
    for (const event of session.events) {
      const js = isJavaScriptResource(event.url, event.resourceType);
      const map = isSourceMapResource(event.url) || event.mimeType.includes('source-map');
      if (!js && !map) continue;
      const inlineMap = js ? inlineSourceMap(event.responseBody) : null;
      const item = {
        seq: event.seq,
        url: event.url,
        status: event.status,
        bytes: event.responseBody.length,
        artifact_id: event.artifact?.sha256 ?? null,
        artifact_ref: event.artifact?.ref ?? null,
        source_map: js ? sourceMapDirective(event.responseBody) : null,
        inline_source_map: Boolean(inlineMap),
      };
      if (js) chunks.push(item);
      if (map) sourceMaps.push(item);
      for (const candidate of extractCandidates(event.responseBody)) candidates.add(candidate);
      if (inlineMap) {
        sourceMaps.push({ ...item, url: `inline:${event.url}`, inline_source_map: true });
        for (const candidate of extractCandidates(inlineMap)) candidates.add(candidate);
      }
    }
    return { chunks: chunks.slice(-80), sourceMaps: sourceMaps.slice(-40), candidates: [...candidates].slice(0, 300) };
  }

  async closeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.closing = true;
    this.sessions.delete(id);
    await session.page.close().catch(() => undefined);
    await session.context.close().catch(() => undefined);
  }

  async closeTask(missionId: string, taskId: string): Promise<void> {
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      if (session.missionId === missionId && session.taskId === taskId) await this.closeSession(session.id);
    }
  }

  private publicEvent(event: NetworkEvent): Record<string, unknown> {
    const requestText = [
      `${event.method} ${event.url}`,
      ...Object.entries(event.requestHeaders).map(([key, value]) => `${key}: ${value}`),
      '',
      event.requestBody,
    ].join('\n');
    const responseText = [
      `HTTP ${event.status}`,
      ...Object.entries(event.responseHeaders).map(([key, value]) => `${key}: ${value}`),
      '',
      event.responseBody.slice(0, 8_000),
    ].join('\n');
    return {
      seq: event.seq,
      method: event.method,
      url: event.url,
      status: event.status,
      resource_type: event.resourceType,
      mime_type: event.mimeType,
      request_text: requestText.slice(0, 12_000),
      response_text: responseText.slice(0, 16_000),
      response_truncated: event.responseBodyTruncated,
      artifact_id: event.artifact?.sha256 ?? null,
      artifact_size: event.artifact?.size ?? null,
      error: event.error,
    };
  }

  private async reapIdleSessions(): Promise<void> {
    const now = Date.now();
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      if (now - session.lastUsedAt > this.config.sessionTtlMs) await this.closeSession(session.id);
    }
  }

  async dispose(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
    const sessions = [...this.sessions.values()];
    for (const session of sessions) await this.closeSession(session.id);
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }
}
