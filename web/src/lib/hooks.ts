import { useEffect, useState } from 'react';
import { QueryKey, useMutation, useQuery, useQueryClient, UseQueryOptions } from '@tanstack/react-query';
import { api } from './api';
import { onRealtime } from './socket';
import { toast } from '../components/Toast';

export function useApi<T = any>(key: QueryKey, path: string | null, query?: Record<string, any>, opts?: Partial<UseQueryOptions<T>>) {
  return useQuery<T>({
    queryKey: [...(Array.isArray(key) ? key : [key]), query ?? {}],
    queryFn: () => api<T>(path!, { query }),
    enabled: !!path && (opts?.enabled ?? true),
    ...opts,
  } as any);
}

/** Mutation that invalidates query keys and shows toast feedback. */
export function useAction<V = any, R = any>(fn: (v: V) => Promise<R>, opts: { invalidate?: QueryKey[]; success?: string | ((r: R) => string); onSuccess?: (r: R) => void } = {}) {
  const qc = useQueryClient();
  return useMutation<R, any, V>({
    mutationFn: fn,
    onSuccess: (r) => {
      (opts.invalidate ?? []).forEach((k) => qc.invalidateQueries({ queryKey: k }));
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success);
      opts.onSuccess?.(r);
    },
    onError: (e: any) => toast.error(e?.message ?? 'Something went wrong'),
  });
}

/** Refetch the given queries whenever the server signals relevant changes. */
export function useLiveRefresh(keys: QueryKey[]) {
  const qc = useQueryClient();
  useEffect(() => onRealtime('data:changed', () => keys.forEach((k) => qc.invalidateQueries({ queryKey: k }))), [qc, JSON.stringify(keys)]);
}

export function useMediaQuery(q: string) {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const h = () => setM(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [q]);
  return m;
}

export function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/** Persist a small UI preference (view mode etc.). */
export function usePref<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => { try { const s = localStorage.getItem(`pref:${key}`); return s ? JSON.parse(s) : initial; } catch { return initial; } });
  useEffect(() => { try { localStorage.setItem(`pref:${key}`, JSON.stringify(v)); } catch { /* ignore */ } }, [key, v]);
  return [v, setV] as const;
}
