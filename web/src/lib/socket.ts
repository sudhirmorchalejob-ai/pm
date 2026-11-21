import { io, Socket } from 'socket.io-client';
import { getAccessToken, refreshAccessToken } from './api';

let socket: Socket | null = null;
type Handler = (payload: any) => void;
const handlers = new Map<string, Set<Handler>>();

export function connectSocket() {
  if (socket) return;
  socket = io({ path: '/socket.io', auth: (cb) => cb({ token: getAccessToken() }), transports: ['websocket', 'polling'] });
  socket.on('connect_error', async (e) => {
    if (e.message === 'unauthorized') { await refreshAccessToken(); setTimeout(() => socket?.connect(), 1000); }
  });
  socket.onAny((event, payload) => handlers.get(event)?.forEach((h) => h(payload)));
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

export function onRealtime(event: string, h: Handler) {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event)!.add(h);
  return () => { handlers.get(event)?.delete(h); };
}
