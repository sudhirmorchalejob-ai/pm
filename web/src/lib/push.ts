import { api } from './api';

const b64ToUint8 = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** Register the service worker and subscribe this browser for server-sent Web Push. */
export async function enableBrowserPush(): Promise<string> {
  if (!pushSupported()) throw new Error('This browser does not support push notifications');
  const { key } = await api<{ key: string | null }>('/notifications/push/public-key');
  if (!key) throw new Error('Browser push is not configured on the server (VAPID keys missing)');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notification permission was not granted');
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(key) }));
  await api('/notifications/push/subscribe', { body: sub.toJSON() });
  return 'Browser push enabled for this device';
}

export async function disableBrowserPush() {
  const reg = await navigator.serviceWorker?.getRegistration('/sw.js');
  const sub = await reg?.pushManager.getSubscription();
  if (sub) { await api('/notifications/push/unsubscribe', { body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); }
}
