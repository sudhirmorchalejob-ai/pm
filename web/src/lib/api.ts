/**
 * API client: attaches the access token, transparently refreshes it once on 401
 * (refresh token lives in an httpOnly cookie), and surfaces server validation errors.
 */
let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
let onSessionLost: (() => void) | null = null;

export const setAccessToken = (t: string | null) => { accessToken = t; };
export const getAccessToken = () => accessToken;
export const setSessionLostHandler = (fn: () => void) => { onSessionLost = fn; };

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: any) { super(message); }
  get fieldErrors(): Record<string, string[]> { return this.details?.fieldErrors ?? {}; }
}

export async function refreshAccessToken(): Promise<string | null> {
  refreshing ??= (async () => {
    try {
      const r = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      if (!r.ok) return null;
      const j = await r.json();
      accessToken = j.accessToken;
      return accessToken;
    } catch { return null; } finally { setTimeout(() => { refreshing = null; }, 0); }
  })();
  return refreshing;
}

type Opts = { method?: string; body?: any; query?: Record<string, any>; raw?: boolean; form?: FormData };

function qs(query?: Record<string, any>) {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export async function api<T = any>(path: string, opts: Opts = {}, retry = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}${qs(opts.query)}`, {
    method: opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET'),
    headers, credentials: 'include',
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  if (res.status === 401 && retry && !path.startsWith('/auth/login')) {
    const t = await refreshAccessToken();
    if (t) return api<T>(path, opts, false);
    onSessionLost?.();
  }
  if (!res.ok) {
    let j: any = {};
    try { j = await res.json(); } catch { /* not json */ }
    throw new ApiError(res.status, j.error ?? res.statusText, j.details);
  }
  if (opts.raw) return res as any;
  if (res.status === 204) return undefined as T;
  return res.json();
}

/** Download a binary response (Excel/PDF exports, attachments) with auth. */
export async function download(path: string, query?: Record<string, any>) {
  const res: Response = await api(path, { query, raw: true });
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const name = decodeURIComponent(/filename="?([^"]+)"?/.exec(cd)?.[1] ?? 'download');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
