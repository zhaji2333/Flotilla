import { Send } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { canOperate } from '../lib/permissions';
import { useToast } from './toast';
import { Button, Field, Textarea } from './ui';

export function HintComposer({ missionId, taskId, onCreated }: { missionId: string; taskId?: string; onCreated: () => void }) {
  const toast = useToast();
  const { user } = useAuth();
  const [content, setContent] = useState('');
  const [pending, setPending] = useState(false);
  if (!canOperate(user)) return null;

  async function submit(): Promise<void> {
    const trimmed = content.trim();
    if (trimmed.length < 2) {
      toast('error', '提示内容至少需要 2 个字符。');
      return;
    }
    setPending(true);
    try {
      await api.createHint({ missionId, taskId, content: trimmed, source: 'operator' });
      toast('success', '提示已加入队列，将在下一轮上下文中注入。');
      setContent('');
      onCreated();
    } catch (cause) {
      toast('error', cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="border border-line bg-panel p-4">
      <p className="micro mb-3">人工提示 · 注入下一轮上下文</p>
      <Field label="提示内容" hint="操作员提示会进入 hint 队列；Worker 或 Planner 在下一轮消费，不会直接改写任务状态。">
        <Textarea
          value={content}
          onChange={event => setContent(event.target.value)}
          placeholder="例如：优先检查 /admin 下的越权接口，并保留 baseline/proof 证据。"
          rows={3}
        />
      </Field>
      <div className="mt-3 flex justify-end">
        <Button
          variant="primary"
          icon={<Send className="size-3.5" aria-hidden="true" />}
          disabled={pending}
          onClick={() => void submit()}
        >
          {pending ? '提交中' : '加入提示队列'}
        </Button>
      </div>
    </div>
  );
}
