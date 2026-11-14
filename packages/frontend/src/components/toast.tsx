import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';

type ToastTone = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

const ToastContext = createContext<(tone: ToastTone, message: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((tone: ToastTone, message: string) => {
    const id = Date.now() + Math.random();
    setItems(current => [...current, { id, tone, message }]);
    window.setTimeout(() => setItems(current => current.filter(item => item.id !== id)), 5200);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[70] flex w-[min(92vw,380px)] flex-col gap-2">
        <AnimatePresence initial={false}>
          {items.map(item => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: 14, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
              className={cn(
                'pointer-events-auto flex items-start gap-3 border bg-panel px-4 py-3 shadow-2xl',
                item.tone === 'success' && 'border-lime/40',
                item.tone === 'error' && 'border-ember/50',
                item.tone === 'info' && 'border-line',
              )}
            >
              {item.tone === 'success' ? <CheckCircle2 className="mt-0.5 size-4 text-lime" aria-hidden="true" /> : null}
              {item.tone === 'error' ? <AlertTriangle className="mt-0.5 size-4 text-ember" aria-hidden="true" /> : null}
              {item.tone === 'info' ? <Info className="mt-0.5 size-4 text-muted" aria-hidden="true" /> : null}
              <p className="flex-1 text-sm leading-relaxed text-paper">{item.message}</p>
              <button
                type="button"
                aria-label="关闭提示"
                className="text-faint transition-colors hover:text-paper"
                onClick={() => setItems(current => current.filter(entry => entry.id !== item.id))}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (tone: ToastTone, message: string) => void {
  return useContext(ToastContext);
}
