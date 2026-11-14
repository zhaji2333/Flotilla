import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '../lib/utils';

export interface SpringSelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

// Deliberately restrained menu motion: a short ease-out settle, no overshoot,
// no bounce. Keyboard-first and compact for frequent project sorting.
const MENU_TRANSITION = { duration: 0.1, ease: [0.2, 0, 0, 1] as const };

export function SpringSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
  fullWidth = false,
  size = 'compact',
  id,
  disabled = false,
  title,
}: {
  value: T;
  options: ReadonlyArray<SpringSelectOption<T>>;
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
  fullWidth?: boolean;
  size?: 'compact' | 'field';
  id?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.findIndex(option => option.value === value)));
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const selected = options.find(option => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    setActiveIndex(Math.max(0, options.findIndex(option => option.value === value)));
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setDropUp(window.innerHeight - rect.bottom < 220 && rect.top > 220);
    function onPointerDown(event: PointerEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, options, value]);

  function choose(option: SpringSelectOption<T>): void {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onListKeyDown(event: React.KeyboardEvent<HTMLUListElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex(index => Math.min(Math.max(index + delta, 0), options.length - 1));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) choose(option);
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className={cn('relative', fullWidth ? 'w-full' : 'w-auto', className)}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        title={title}
        className={cn(
          'input flex items-center justify-between gap-3 border-line bg-ink-2 text-left tracking-[0.02em] text-paper disabled:cursor-not-allowed disabled:opacity-50',
          fullWidth ? 'w-full min-w-0' : 'w-auto min-w-[126px]',
          size === 'field' ? 'h-10 px-3 py-0 text-[12px]' : 'h-8 px-3 py-0 text-[11px]',
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => { if (!disabled) setOpen(current => !current); }}
        onKeyDown={event => {
          if (disabled) return;
          if ((event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') && !open) {
            event.preventDefault();
            setOpen(true);
            window.setTimeout(() => document.getElementById(listId)?.focus(), 0);
          }
        }}
      >
        <span className="truncate">{selected?.label ?? '—'}</span>
        <span className={cn('inline-flex shrink-0 transition-transform duration-150 ease-out', open ? 'rotate-180' : 'rotate-0')}>
          <ChevronDown className="size-3.5 text-faint" aria-hidden="true" />
        </span>
      </button>
      <AnimatePresence>
        {open ? (
          <motion.ul
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            tabIndex={-1}
            initial={{ opacity: 0, y: dropUp ? 4 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: dropUp ? 3 : -3 }}
            transition={MENU_TRANSITION}
            onKeyDown={onListKeyDown}
            className={cn(
              'absolute z-[70] min-w-full overflow-hidden border border-line bg-panel py-1 shadow-[0_14px_34px_rgba(0,0,0,0.38)] focus:outline-none',
              dropUp ? 'bottom-[calc(100%+4px)]' : 'top-[calc(100%+4px)]',
              fullWidth ? 'w-full' : 'w-max max-w-[360px]',
            )}
          >
            {options.map((option, index) => {
              const isSelected = option.value === value;
              const isActive = index === activeIndex;
              return (
                <li key={option.value} role="option" aria-selected={isSelected} aria-disabled={option.disabled}>
                  <button
                    type="button"
                    disabled={option.disabled}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => choose(option)}
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-2 text-left text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                      isActive ? 'bg-paper/[0.07] text-paper' : 'text-muted',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {isSelected ? <Check className="size-3.5 shrink-0 text-lime" aria-hidden="true" /> : null}
                  </button>
                </li>
              );
            })}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
