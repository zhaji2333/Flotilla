import { useEffect, useRef } from 'react';

// Interactive canvas field: slow orbital drift + pointer parallax. It is pure
// decoration, respects prefers-reduced-motion and never blocks pointer events.
export function BackgroundField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let width = 0;
    let height = 0;
    let frame = 0;
    let visible = true;
    const pointer = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };

    const stars = Array.from({ length: 46 }, (_, index) => ({
      angle: (index / 46) * Math.PI * 2,
      radius: 180 + ((index * 53) % 420),
      speed: 0.00006 + ((index % 7) * 0.000018),
      size: 0.6 + (index % 3) * 0.35,
    }));

    const resize = (): void => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const onPointer = (event: PointerEvent): void => {
      pointer.tx = event.clientX / width - 0.5;
      pointer.ty = event.clientY / height - 0.5;
    };

    const onVisibility = (): void => {
      visible = document.visibilityState === 'visible';
    };

    const draw = (time: number): void => {
      if (!visible) {
        frame = requestAnimationFrame(draw);
        return;
      }
      pointer.x += (pointer.tx - pointer.x) * 0.045;
      pointer.y += (pointer.ty - pointer.y) * 0.045;
      context.clearRect(0, 0, width, height);
      const centerX = width * 0.74 + pointer.x * 34;
      const centerY = height * 0.42 + pointer.y * 26;
      const ambient = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, Math.max(width, height) * 0.6);
      ambient.addColorStop(0, 'rgba(215,255,63,0.045)');
      ambient.addColorStop(0.45, 'rgba(90,169,255,0.02)');
      ambient.addColorStop(1, 'rgba(0,0,0,0)');
      context.fillStyle = ambient;
      context.fillRect(0, 0, width, height);

      for (const star of stars) {
        const angle = star.angle + (reduced ? 0 : time * star.speed);
        const x = centerX + Math.cos(angle) * star.radius + pointer.x * star.radius * 0.04;
        const y = centerY + Math.sin(angle) * star.radius * 0.52 + pointer.y * star.radius * 0.03;
        context.beginPath();
        context.fillStyle = star.size > 1 ? 'rgba(215,255,63,0.5)' : 'rgba(242,239,230,0.3)';
        context.arc(x, y, star.size, 0, Math.PI * 2);
        context.fill();
        context.beginPath();
        context.strokeStyle = 'rgba(242,239,230,0.035)';
        context.lineWidth = 0.6;
        context.moveTo(centerX, centerY);
        context.lineTo(x, y);
        context.stroke();
      }
      frame = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', onPointer, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 opacity-70"
    />
  );
}
