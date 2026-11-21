import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { config } from '../config';
import { verifyAccessToken } from '../auth/tokens';
import { createRedis, redis } from './redis';
import { logger } from './logger';

/**
 * Real-time push. Any process (API or worker) publishes to a Redis channel;
 * every API process relays to its connected sockets. Each user joins room `u:<id>`.
 */
const CHANNEL = 'orgpm:realtime';
let io: Server | null = null;

export function attachRealtime(server: HttpServer) {
  io = new Server(server, {
    path: '/socket.io',
    cors: { origin: config.CORS_ORIGINS.split(','), credentials: true },
  });
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string;
      const { sub } = verifyAccessToken(token);
      socket.data.userId = sub;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', (s) => s.join(`u:${s.data.userId}`));

  const sub = createRedis();
  sub.subscribe(CHANNEL).catch((e) => logger.error(e, 'realtime subscribe failed'));
  sub.on('message', (_c, msg) => {
    try {
      const { userIds, event, payload } = JSON.parse(msg);
      for (const id of userIds as number[]) io?.to(`u:${id}`).emit(event, payload);
    } catch (e) {
      logger.warn(e, 'bad realtime message');
    }
  });
  return io;
}

export async function pushRealtime(userIds: number[], event: string, payload: unknown) {
  if (!userIds.length || config.NODE_ENV === 'test') return;
  try {
    await redis().publish(CHANNEL, JSON.stringify({ userIds, event, payload }));
  } catch (e) {
    logger.warn(e, 'realtime publish failed');
  }
}
