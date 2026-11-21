import 'dotenv/config';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().default('postgres://postgres@localhost:5432/orgpm'),
  DATABASE_SSL: z.enum(['auto', 'true', 'false']).default('auto'),
  // Managed providers (Render, Heroku…) use certificates Node does not trust by default.
  DATABASE_SSL_REJECT_UNAUTHORIZED: bool,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  QUEUE_PREFIX: z.string().default('orgpm'),
  JWT_ACCESS_SECRET: z.string().min(16).default('dev-access-secret-change-me-please'),
  JWT_REFRESH_SECRET: z.string().min(16).default('dev-refresh-secret-change-me-please'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(14),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  APP_URL: z.string().default('http://localhost:5173'),
  UPLOAD_DIR: z.string().default('uploads'),
  MAX_UPLOAD_MB: z.coerce.number().default(25),
  DEFAULT_TIMEZONE: z.string().default('Asia/Kolkata'),
  // Email (SMTP). Leave SMTP_HOST empty to disable the email channel.
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: bool,
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_FROM: z.string().default('OrgPM <no-reply@orgpm.local>'),
  // Browser push (Web Push / VAPID). Generate with: npx web-push generate-vapid-keys
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default('mailto:admin@orgpm.local'),
  // Mobile push (Firebase Cloud Messaging HTTP v1)
  FCM_PROJECT_ID: z.string().default(''),
  FCM_SERVICE_ACCOUNT_JSON: z.string().default(''),
  // WhatsApp (Meta WhatsApp Cloud API)
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
  WHATSAPP_ACCESS_TOKEN: z.string().default(''),
  WHATSAPP_TEMPLATE_NAME: z.string().default(''),
  WHATSAPP_TEMPLATE_LANG: z.string().default('en'),
  // Run BullMQ workers inside the API process (single-node / dev convenience).
  RUN_WORKERS_IN_API: bool,
  LOG_LEVEL: z.string().default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const config = parsed.data;

if (config.NODE_ENV === 'production') {
  for (const k of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
    if (config[k].startsWith('dev-')) {
      console.error(`${k} must be set to a strong secret in production`);
      process.exit(1);
    }
  }
}
