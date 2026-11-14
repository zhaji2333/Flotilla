import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import * as Tooltip from '@radix-ui/react-tooltip';
import { AlertTriangle, Check, Copy, Loader2, X } from 'lucide-react';
import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cn } from '../lib/utils';

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger';

export function Button({
  variant = 'outline',
  icon,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; icon?: ReactNode }) {
  return (
    <button type="button" className={cn('btn', `btn-${variant}`, className)} {...props}>
      {icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded border border-line text-muted transition-colors hover:border-muted hover:text-paper',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function Panel({ children, className, as: Tag = 'div' }: { children: ReactNode; className?: string; as?: 'div' | 'section' | 'article' }) {
  return <Tag className={cn('panel', className)}>{children}</Tag>;
}

export function SectionLabel({ index, children, right }: { index?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div className="flex items-baseline gap-3">
        {index ? <span className="mono text-[10px] tracking-[0.3em] text-lime">{index}</span> : null}
        <h2 className="display text-[13px] tracking-[0.18em] text-paper">{children}</h2>
      </div>
      {right}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'lime' | 'ember' | 'sky' | 'violet' | 'muted';
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'border-line text-muted',
    lime: 'border-lime/40 text-lime bg-lime/5',
    ember: 'border-ember/40 text-ember bg-ember/5',
    sky: 'border-sky/40 text-sky bg-sky/5',
    violet: 'border-violet/40 text-violet bg-violet/5',
    muted: 'border-line text-faint',
  };
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.14em]', tones[tone], className)}>
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} aria-hidden="true" />;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-muted">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      {label ? <span className="micro">{label}</span> : null}
    </span>
  );
}

export function EmptyState({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 border border-dashed border-line px-6 py-14 text-center">
      {icon ? <div className="text-faint">{icon}</div> : null}
      <p className="display text-[12px] tracking-[0.16em] text-paper">{title}</p>
      {hint ? <p className="max-w-md text-sm text-muted">{hint}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 border border-ember/30 bg-ember/5 px-5 py-4">
      <div className="flex items-center gap-2 text-ember">
        <AlertTriangle className="size-4" aria-hidden="true" />
        <span className="micro tracking-[0.18em] text-ember">请求失败</span>
      </div>
      <p className="mono text-xs text-ember/90">{error}</p>
      {retry ? (
        <Button variant="outline" onClick={retry}>
          重试
        </Button>
      ) : null}
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="micro mb-2 block text-muted">{label}</span>
      {children}
      {error ? <span className="mt-1.5 block text-xs text-ember">{error}</span> : null}
      {hint && !error ? <span className="mt-1.5 block text-xs text-faint">{hint}</span> : null}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('input', className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn('input min-h-28 resize-y', className)} {...props} />;
}


export function CopyButton({ value, label = '复制' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded border border-line px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-muted transition-colors hover:border-muted hover:text-paper"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        });
      }}
    >
      {copied ? <Check className="size-3 text-lime" aria-hidden="true" /> : <Copy className="size-3" aria-hidden="true" />}
      {copied ? '已复制' : label}
    </button>
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/80 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[86vh] w-[min(92vw,620px)] -translate-x-1/2 -translate-y-1/2 overflow-auto border border-line bg-panel p-6 shadow-[0_40px_120px_rgba(0,0,0,0.7)] focus:outline-none">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="display text-lg tracking-[0.04em] text-paper">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-2 text-sm text-muted">{description}</Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close asChild>
              <IconButton label="关闭">
                <X className="size-4" aria-hidden="true" />
              </IconButton>
            </Dialog.Close>
          </div>
          {children}
          {footer ? <div className="mt-6 flex justify-end gap-2 border-t border-line pt-4">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function TabsRoot({ value, onValueChange, children }: { value: string; onValueChange: (value: string) => void; children: ReactNode }) {
  return (
    <Tabs.Root value={value} onValueChange={onValueChange}>
      {children}
    </Tabs.Root>
  );
}

export function TabsList({ children }: { children: ReactNode }) {
  return (
    <Tabs.List className="mb-5 flex flex-wrap items-center gap-1 border-b border-line pb-3">
      {children}
    </Tabs.List>
  );
}

export function TabTrigger({ value, children, count }: { value: string; children: ReactNode; count?: number }) {
  return (
    <Tabs.Trigger
      value={value}
      className="tab-trigger group inline-flex items-center gap-2 whitespace-nowrap rounded px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-muted transition-colors hover:text-paper"
    >
      {children}
      {typeof count === 'number' ? (
        <span className="mono text-[10px] opacity-70 group-data-[state=active]:opacity-100">{count}</span>
      ) : null}
    </Tabs.Trigger>
  );
}

export function TabContent({ value, children }: { value: string; children: ReactNode }) {
  return (
    <Tabs.Content value={value} className="focus:outline-none">
      {children}
    </Tabs.Content>
  );
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={250}>
      {children}
    </Tooltip.Provider>
  );
}

export function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          sideOffset={6}
          className="z-50 max-w-56 border border-line bg-panel px-2.5 py-1.5 text-[11px] leading-relaxed text-muted shadow-xl"
        >
          {label}
          <Tooltip.Arrow className="fill-line" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
