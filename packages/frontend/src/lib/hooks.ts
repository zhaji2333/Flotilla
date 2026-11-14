import { useCallback, useEffect, useRef, useState } from 'react';
import { streamUrl } from './api';
import type { MissionStreamFrame } from './types';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Minimal async data hook with manual refresh; no client cache library needed. */
export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    setError(null);
    loader()
      .then(value => {
        if (alive.current) setData(value);
      })
      .catch((cause: unknown) => {
        if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, refresh: () => setNonce(value => value + 1) };
}

export interface MissionStreamState {
  frame: MissionStreamFrame | null;
  connected: boolean;
  gone: boolean;
}

/** Subscribes to the contract SSE stream; EventSource reconnects automatically. */
export function useMissionStream(missionId: string | undefined): MissionStreamState {
  const [frame, setFrame] = useState<MissionStreamFrame | null>(null);
  const [connected, setConnected] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (!missionId) return;
    // Dev-only: ?static=1 disables SSE so headless screenshot tools can finish.
    if (import.meta.env.DEV && window.location.search.includes('static=1')) return;
    setFrame(null);
    setGone(false);
    const source = new EventSource(streamUrl(missionId));
    const onOpen = (): void => setConnected(true);
    const onError = (): void => setConnected(false);
    const onMessage = (event: MessageEvent<string>): void => {
      try {
        const data = JSON.parse(event.data) as MissionStreamFrame;
        setFrame(data);
        if (data.type === 'gone') {
          setGone(true);
          source.close();
        }
      } catch {
        // ignore malformed frame
      }
    };
    source.addEventListener('open', onOpen);
    source.addEventListener('error', onError);
    source.addEventListener('message', onMessage);
    return () => {
      source.removeEventListener('open', onOpen);
      source.removeEventListener('error', onError);
      source.removeEventListener('message', onMessage);
      source.close();
      setConnected(false);
    };
  }, [missionId]);

  return { frame, connected, gone };
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = (): void => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useDisclosure(initial = false): {
  open: boolean;
  setOpen: (value: boolean) => void;
  toggle: () => void;
} {
  const [open, setOpen] = useState(initial);
  const toggle = useCallback(() => setOpen(value => !value), []);
  return { open, setOpen, toggle };
}
