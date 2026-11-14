import { Maximize2, Minus, Plus, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/utils';

interface ViewState {
  x: number;
  y: number;
  scale: number;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 3;

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

/**
 * Pannable / zoomable graph viewport.
 * - Drag with the primary pointer to translate.
 * - Mouse wheel or +/- controls zoom around the pointer/center.
 * - Fit resets to show the full SVG.
 */
export function GraphCanvas({
  children,
  ariaLabel,
  className,
  height = 560,
}: {
  children: ReactNode;
  ariaLabel: string;
  className?: string;
  height?: number;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const movedRef = useRef(false);
  const [view, setView] = useState<ViewState>({ x: 16, y: 16, scale: 1 });
  const [dragging, setDragging] = useState(false);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const svg = content.querySelector('svg');
    const width = svg ? Number(svg.getAttribute('width')) : content.offsetWidth;
    const heightValue = svg ? Number(svg.getAttribute('height')) : content.offsetHeight;
    if (!Number.isFinite(width) || !Number.isFinite(heightValue) || width <= 0 || heightValue <= 0) return;
    const scale = clampScale(Math.min((viewport.clientWidth - 32) / width, (viewport.clientHeight - 32) / heightValue, 1));
    setView({
      scale,
      x: Math.max(16, (viewport.clientWidth - width * scale) / 2),
      y: Math.max(16, (viewport.clientHeight - heightValue * scale) / 2),
    });
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(fit);
    return () => window.cancelAnimationFrame(frame);
  }, [fit]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * 0.0015);
      setView(current => {
        const nextScale = clampScale(current.scale * factor);
        const ratio = nextScale / current.scale;
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        return {
          scale: nextScale,
          x: px - (px - current.x) * ratio,
          y: py - (py - current.y) * ratio,
        };
      });
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, []);

  function zoomAtCenter(factor: number): void {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const cx = viewport.clientWidth / 2;
    const cy = viewport.clientHeight / 2;
    setView(current => {
      const nextScale = clampScale(current.scale * factor);
      const ratio = nextScale / current.scale;
      return {
        scale: nextScale,
        x: cx - (cx - current.x) * ratio,
        y: cy - (cy - current.y) * ratio,
      };
    });
  }

  return (
    <div
      ref={viewportRef}
      role="application"
      aria-label={ariaLabel}
      className={cn('relative touch-none overflow-hidden border border-line bg-ink-2/50 select-none', dragging ? 'cursor-grabbing' : 'cursor-grab', className)}
      style={{ height }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          originX: view.x,
          originY: view.y,
        };
        movedRef.current = false;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={event => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) movedRef.current = true;
        setView(current => ({ ...current, x: drag.originX + dx, y: drag.originY + dy }));
      }}
      onPointerUp={event => {
        const drag = dragRef.current;
        if (drag && event.currentTarget.hasPointerCapture(drag.pointerId)) event.currentTarget.releasePointerCapture(drag.pointerId);
        dragRef.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        dragRef.current = null;
        setDragging(false);
      }}
      onClickCapture={event => {
        if (movedRef.current) {
          event.preventDefault();
          event.stopPropagation();
          movedRef.current = false;
        }
      }}
    >
      <div
        ref={contentRef}
        className="absolute left-0 top-0 origin-top-left will-change-transform"
        style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }}
      >
        {children}
      </div>

      <div className="absolute right-2 top-2 z-10 flex items-center gap-1 border border-line bg-panel/95 p-1 shadow-[0_6px_24px_rgba(0,0,0,0.35)]" onPointerDown={event => event.stopPropagation()}>
        <button type="button" className="inline-flex size-7 items-center justify-center text-muted hover:bg-surface-2 hover:text-paper" title="缩小" aria-label="缩小" onClick={() => zoomAtCenter(0.82)}><Minus className="size-3.5" aria-hidden="true" /></button>
        <span className="mono min-w-10 text-center text-[9px] text-faint">{Math.round(view.scale * 100)}%</span>
        <button type="button" className="inline-flex size-7 items-center justify-center text-muted hover:bg-surface-2 hover:text-paper" title="放大" aria-label="放大" onClick={() => zoomAtCenter(1.22)}><Plus className="size-3.5" aria-hidden="true" /></button>
        <span className="mx-0.5 h-4 w-px bg-line" aria-hidden="true" />
        <button type="button" className="inline-flex size-7 items-center justify-center text-muted hover:bg-surface-2 hover:text-paper" title="适应窗口" aria-label="适应窗口" onClick={fit}><Maximize2 className="size-3.5" aria-hidden="true" /></button>
        <button type="button" className="inline-flex size-7 items-center justify-center text-muted hover:bg-surface-2 hover:text-paper" title="重置视图" aria-label="重置视图" onClick={() => { setView({ x: 16, y: 16, scale: 1 }); }}><RotateCcw className="size-3.5" aria-hidden="true" /></button>
      </div>
      <span className="pointer-events-none absolute bottom-2 left-3 mono text-[9px] uppercase tracking-[0.12em] text-faint">拖拽平移 · 滚轮缩放</span>
    </div>
  );
}
