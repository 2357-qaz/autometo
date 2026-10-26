// Browser side of Web Push: subscribe this device with the sync server.
import type { SyncConfig } from '@automedo/core';
import { isIOS, isNativeApp, isStandalone } from './pwa';

export type PushState =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'denied' }
  | { kind: 'off' }
  | { kind: 'on' };

const api = (cfg: SyncConfig, path: string, body?: unknown) =>
  fetch(`${cfg.url.replace(/\/+$/, '')}/v1/push/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => {
    if (!r.ok) throw new Error(r.status === 404 ? '服务器未开启推送' : `服务器错误 ${r.status}`);
    return r.json();
  });

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(b.length));
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function pushState(): Promise<PushState> {
  if (isNativeApp()) return { kind: 'unsupported', reason: 'native' };
  if (isIOS() && !isStandalone()) return { kind: 'unsupported', reason: 'ios-install' };
  if (!('Notification' in window) || !('PushManager' in window)) return { kind: 'unsupported', reason: 'browser' };
  const reg = await registration();
  if (!reg) return { kind: 'unsupported', reason: 'no-sw' };
  if (Notification.permission === 'denied') return { kind: 'denied' };
  return (await reg.pushManager.getSubscription()) ? { kind: 'on' } : { kind: 'off' };
}

/** Must be called from a user gesture (iOS requirement for the permission prompt). */
export async function enablePush(cfg: SyncConfig): Promise<void> {
  const reg = await registration();
  if (!reg) throw new Error('离线缓存（Service Worker）还没准备好，刷新后再试');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('没有获得通知权限');
  const { publicKey } = (await api(cfg, 'key')) as { publicKey: string };
  const existing = await reg.pushManager.getSubscription();
  // A subscription made for another server's key can't be reused.
  if (existing) await existing.unsubscribe();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) });
  const label = isIOS() ? 'iPhone / iPad' : /Android/.test(navigator.userAgent) ? 'Android' : 'Desktop';
  await api(cfg, 'subscribe', { subscription: sub.toJSON(), label });
}

export async function disablePush(cfg: SyncConfig): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return;
  await api(cfg, 'unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

export async function testPush(cfg: SyncConfig): Promise<number> {
  const r = (await api(cfg, 'test', {})) as { sent: number };
  return r.sent;
}
