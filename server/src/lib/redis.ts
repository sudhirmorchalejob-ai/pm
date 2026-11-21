import IORedis from 'ioredis';
import { config } from '../config';

/** BullMQ requires maxRetriesPerRequest: null on its connections. */
export const createRedis = () => new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });

let shared: IORedis | null = null;
export const redis = () => (shared ??= createRedis());
