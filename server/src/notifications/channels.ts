import jwt from 'jsonwebtoken';
import nodemailer, { Transporter } from 'nodemailer';
import webpush from 'web-push';
import { config } from '../config';
import { db } from '../db/knex';
import { pushRealtime } from '../lib/realtime';

export type Channel = 'in_app' | 'email' | 'browser_push' | 'mobile_push' | 'whatsapp';
export const CHANNELS: Channel[] = ['in_app', 'email', 'browser_push', 'mobile_push', 'whatsapp'];

export interface DeliveryLog {
  id: number; user_id: number; channel: Channel; title: string; body: string; link: string | null; category: string;
}
export interface DeliveryResult { status: 'sent' | 'delivered' | 'skipped'; providerRef?: string; note?: string }

/** Thrown for non-retryable failures (bad address, provider rejected permanently). */
export class PermanentDeliveryError extends Error {}

export function channelStatus() {
  return {
    in_app: { configured: true, note: 'Always available' },
    email: { configured: !!config.SMTP_HOST, note: config.SMTP_HOST ? `SMTP ${config.SMTP_HOST}` : 'Set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM' },
    browser_push: { configured: !!(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY), note: 'Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (npx web-push generate-vapid-keys)' },
    mobile_push: { configured: !!(config.FCM_PROJECT_ID && config.FCM_SERVICE_ACCOUNT_JSON), note: 'Set FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_JSON (Firebase service account)' },
    whatsapp: { configured: !!(config.WHATSAPP_PHONE_NUMBER_ID && config.WHATSAPP_ACCESS_TOKEN), note: 'Set WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN (Meta WhatsApp Cloud API) and an approved template' },
  } as Record<Channel, { configured: boolean; note: string }>;
}

const absLink = (link: string | null) => (link ? `${config.APP_URL}${link}` : config.APP_URL);

// ---- in-app --------------------------------------------------------------
async function inApp(log: DeliveryLog): Promise<DeliveryResult> {
  const unread = await db('notification_logs').where({ user_id: log.user_id, channel: 'in_app' })
    .whereIn('status', ['delivered', 'sent']).count({ c: '*' }).first();
  await pushRealtime([log.user_id], 'notification', {
    id: log.id, title: log.title, body: log.body, link: log.link, category: log.category, unread: Number(unread?.c ?? 0) + 1,
  });
  return { status: 'delivered' };
}

// ---- email ---------------------------------------------------------------
let transporter: Transporter | null = null;
async function email(log: DeliveryLog): Promise<DeliveryResult> {
  if (!config.SMTP_HOST) return { status: 'skipped', note: 'Email channel not configured (SMTP_HOST)' };
  transporter ??= nodemailer.createTransport({
    host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
  });
  const user = await db('users').where({ id: log.user_id }).first('email', 'name');
  if (!user?.email) throw new PermanentDeliveryError('Recipient has no email address');
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const info = await transporter.sendMail({
    from: config.SMTP_FROM, to: `"${user.name}" <${user.email}>`, subject: log.title,
    text: `${log.body}\n\n${absLink(log.link)}`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:560px"><h2 style="font-size:18px">${esc(log.title)}</h2>
      <p style="white-space:pre-line">${esc(log.body)}</p><p><a href="${absLink(log.link)}">Open in OrgPM</a></p></div>`,
  });
  return { status: 'sent', providerRef: info.messageId };
}

// ---- browser push (Web Push) ----------------------------------------------
let vapidSet = false;
async function browserPush(log: DeliveryLog): Promise<DeliveryResult> {
  if (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY) return { status: 'skipped', note: 'Browser push not configured (VAPID keys)' };
  if (!vapidSet) { webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY); vapidSet = true; }
  const subs = await db('push_subscriptions').where({ user_id: log.user_id });
  if (!subs.length) return { status: 'skipped', note: 'User has no browser push subscription' };
  let ok = 0; let lastErr: any = null;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: log.title, body: log.body, url: log.link ?? '/' }), { TTL: 3600 });
      ok++;
    } catch (e: any) {
      if (e.statusCode === 404 || e.statusCode === 410) await db('push_subscriptions').where({ id: s.id }).del();
      else lastErr = e;
    }
  }
  if (ok) return { status: 'sent', note: `${ok}/${subs.length} subscriptions` };
  if (lastErr) throw lastErr;
  return { status: 'skipped', note: 'All subscriptions expired' };
}

// ---- mobile push (FCM HTTP v1) --------------------------------------------
let fcmToken: { token: string; exp: number } | null = null;
async function fcmAccessToken(): Promise<string> {
  if (fcmToken && fcmToken.exp > Date.now() + 60_000) return fcmToken.token;
  const sa = JSON.parse(config.FCM_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 },
    sa.private_key, { algorithm: 'RS256' });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!r.ok) throw new Error(`FCM auth failed: ${r.status}`);
  const j: any = await r.json();
  fcmToken = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return fcmToken.token;
}
async function mobilePush(log: DeliveryLog): Promise<DeliveryResult> {
  if (!config.FCM_PROJECT_ID || !config.FCM_SERVICE_ACCOUNT_JSON) return { status: 'skipped', note: 'Mobile push not configured (FCM)' };
  const tokens = await db('device_tokens').where({ user_id: log.user_id }).whereIn('platform', ['android', 'ios']);
  if (!tokens.length) return { status: 'skipped', note: 'User has no registered mobile device' };
  const access = await fcmAccessToken();
  let ok = 0;
  for (const t of tokens) {
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${config.FCM_PROJECT_ID}/messages:send`, {
      method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token: t.token, notification: { title: log.title, body: log.body }, data: { link: log.link ?? '/' } } }),
    });
    if (r.ok) ok++;
    else if (r.status === 404 || r.status === 400) await db('device_tokens').where({ id: t.id }).del();
    else throw new Error(`FCM send failed: ${r.status}`);
  }
  return ok ? { status: 'sent', note: `${ok} device(s)` } : { status: 'skipped', note: 'All device tokens invalid' };
}

// ---- WhatsApp (Meta Cloud API) --------------------------------------------
async function whatsapp(log: DeliveryLog): Promise<DeliveryResult> {
  if (!config.WHATSAPP_PHONE_NUMBER_ID || !config.WHATSAPP_ACCESS_TOKEN) return { status: 'skipped', note: 'WhatsApp not configured' };
  const pref = await db('user_notification_preferences').where({ user_id: log.user_id }).first('whatsapp_number');
  const to = pref?.whatsapp_number?.replace(/[^\d]/g, '');
  if (!to) return { status: 'skipped', note: 'User has not opted in with a WhatsApp number' };
  // Business-initiated messages must use an approved template; the body is passed as parameter {{1}}.
  const payload = config.WHATSAPP_TEMPLATE_NAME
    ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: config.WHATSAPP_TEMPLATE_NAME, language: { code: config.WHATSAPP_TEMPLATE_LANG },
        components: [{ type: 'body', parameters: [{ type: 'text', text: `${log.title}: ${log.body}`.slice(0, 1000) }] }] } }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body: `${log.title}\n${log.body}\n${absLink(log.link)}` } };
  const r = await fetch(`https://graph.facebook.com/v21.0/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status >= 400 && r.status < 500 && r.status !== 429) throw new PermanentDeliveryError(`WhatsApp rejected: ${j?.error?.message ?? r.status}`);
    throw new Error(`WhatsApp send failed: ${r.status}`);
  }
  return { status: 'sent', providerRef: j?.messages?.[0]?.id };
}

export const channelHandlers: Record<Channel, (l: DeliveryLog) => Promise<DeliveryResult>> = {
  in_app: inApp, email, browser_push: browserPush, mobile_push: mobilePush, whatsapp,
};
