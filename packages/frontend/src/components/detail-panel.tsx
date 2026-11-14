import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton } from './ui';

// Side detail panel built on the Radix Dialog primitive so focus trapping,
// Escape and aria semantics come for free. Used by the findings mission view.
export function DetailPanel({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="detail-panel-overlay fixed inset-0 z-50 bg-ink/75 backdrop-blur-[2px]" />
        <Dialog.Content className="detail-panel-content fixed right-0 top-0 z-50 flex h-dvh w-full max-w-[780px] flex-col border-l border-white/10 bg-panel shadow-[-40px_0_120px_rgba(0,0,0,0.55)] focus:outline-none">
          <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4 sm:px-6">
            <div className="min-w-0">
              <Dialog.Title className="display text-lg leading-tight tracking-[0.01em] text-paper">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-1.5 text-xs leading-relaxed text-muted">{description}</Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close asChild>
              <IconButton label="关闭详情" className="shrink-0">
                <X className="size-4" aria-hidden="true" />
              </IconButton>
            </Dialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
          {footer ? (
            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface-2 px-5 py-3 sm:px-6">
              {footer}
            </footer>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
