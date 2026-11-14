import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyCommand, commandApprovalHash, guardCommand, isSuspicious, loadCommandGuardConfig, type CommandGuardConfig } from './command-guard.js';

const base: CommandGuardConfig = {
  enabled: true,
  mode: 'block',
  failMode: 'closed',
  model: 'deepseek-flash',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  timeoutMs: 500,
  proxyUrl: 'http://proxy:8080',
};

describe('command guard deterministic rules', () => {
  it('blocks direct destructive effects without calling a model', async () => {
    for (const command of [
      'rm -rf /',
      'rm -rf /etc',
      'mkfs.ext4 /dev/sda1',
      'dd if=/dev/zero of=/dev/sda',
      'systemctl stop nginx',
      'iptables -F',
      'mysql -e "DROP TABLE orders"',
      'useradd attacker',
      'chmod 777 /etc/shadow',
      'shutdown -h now',
    ]) {
      expect(classifyCommand(command).action, command).toBe('deny');
      expect((await guardCommand(command, base)).action, command).toBe('deny');
    }
  });

  it('does not block normal authorized recon or exploit commands', async () => {
    for (const command of [
      'nmap -sV -p- 192.168.1.10',
      'curl -s http://target/robots.txt',
      "sqlmap -u 'http://target/item?id=1' --os-shell",
      'cat /etc/passwd',
      'python3 -c "print(1+1)"',
    ]) {
      expect((await guardCommand(command, { ...base, mode: 'llm', failMode: 'open' })).action, command).toBe('allow');
    }
  });

  it('treats shell wrappers and bulk deletes as suspicious, not silently safe', () => {
    expect(isSuspicious('find /tmp/foo -delete')).toBe(true);
    expect(isSuspicious('bash -c "echo hi"')).toBe(true);
    expect(isSuspicious('python3 -c "import os; os.remove(\'x\')"')).toBe(true);
    expect(isSuspicious('rm -rf /tmp/agent-work')).toBe(true);
    expect(isSuspicious('nmap -sV target')).toBe(false);
  });

  it('can fail closed when the model is unavailable', async () => {
    const decision = await guardCommand('rm -rf /tmp/agent-work', { ...base, mode: 'llm' });
    expect(decision.action).toBe('deny');
    expect(decision.source).toBe('model-failure');
  });

  it('honours the disabled switch', async () => {
    const decision = await guardCommand('rm -rf /', { ...base, enabled: false });
    expect(decision.action).toBe('allow');
    expect(decision.source).toBe('disabled');
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('command guard config', () => {
  it('accepts the internal model proxy token without appending /v1', () => {
    const config = loadCommandGuardConfig({
      LLM_BASE_URL: 'http://api:3001/internal/model/configs/default',
      LLM_API_KEY_ENV: 'MODEL_PROXY_TOKEN',
      MODEL_PROXY_TOKEN: 'proxy-token',
      SRC_AGENT_MISSION_API_URL: 'http://api:3001',
      SRC_AGENT_MISSION_ID: '11111111-1111-4111-8111-111111111111',
      SRC_AGENT_TASK_ID: '22222222-2222-4222-8222-222222222222',
    } as NodeJS.ProcessEnv);
    expect(config.baseUrl).toBe('http://api:3001/internal/model/configs/default');
    expect(config.apiKey).toBe('proxy-token');
    expect(config.approvalBaseUrl).toBe('http://api:3001');
    expect(config.approvalToken).toBe('proxy-token');
  });

  it('uses the separate guard model route when configured', () => {
    const config = loadCommandGuardConfig({
      COMMAND_GUARD_BASE_URL: 'http://api:3001/internal/model/roles/guard',
      MODEL_PROXY_TOKEN: 'proxy-token',
    } as NodeJS.ProcessEnv);
    expect(config.baseUrl).toBe('http://api:3001/internal/model/roles/guard');
    expect(config.apiKey).toBe('proxy-token');
  });

  it('defaults to llm mode with fail-closed and reuses the main LLM route', () => {
    const config = loadCommandGuardConfig({ LLM_MODEL: 'flash', LLM_BASE_URL: 'https://llm/v1', LLM_API_KEY: 'k' } as NodeJS.ProcessEnv);
    expect(config.mode).toBe('llm');
    expect(config.failMode).toBe('closed');
    expect(config.model).toBe('flash');
    expect(config.baseUrl).toBe('https://llm/v1');
    expect(config.apiKey).toBe('k');
  });
});

  it('creates a human review only after the model cannot decide', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/internal/command-approval') && !url.includes('commandHash=')) {
        return new Response(JSON.stringify({ approval: null }), { status: 200 });
      }
      return new Response(JSON.stringify({ approval: { approvalId: 'review-1', status: 'pending' } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const decision = await guardCommand('rm -rf /tmp/agent-work', {
      ...base,
      mode: 'llm',
      missionId: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
      approvalBaseUrl: 'http://api:3001',
      approvalToken: 'proxy-token',
    });
    expect(decision.source).toBe('review');
    expect(decision.action).toBe('deny');
    expect(String(decision.reason)).toContain('review-1');
  });

  it('allows a retry after the same command was approved', async () => {
    const hash = commandApprovalHash('rm -rf /tmp/agent-work');
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/internal/command-approval') && !url.includes('commandHash=')) {
        return new Response(JSON.stringify({ approval: null }), { status: 200 });
      }
      if (!url.includes('commandHash=')) {
        return new Response(JSON.stringify({ approval: null }), { status: 200 });
      }
      return new Response(JSON.stringify({ approval: { approvalId: 'review-1', status: 'approved' } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const decision = await guardCommand('rm -rf /tmp/agent-work', {
      ...base,
      mode: 'llm',
      missionId: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
      approvalBaseUrl: 'http://api:3001',
      approvalToken: 'proxy-token',
    });
    expect(decision.action).toBe('allow');
    expect(decision.source).toBe('review');
    expect(fetchMock).toHaveBeenCalled();
    expect(hash).toHaveLength(64);
  });
