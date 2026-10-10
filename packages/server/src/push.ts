// Web Push: VAPID keys, subscriptions, and the reminder loop.
import webpush, { type PushSubscription } from 'web-push';
import { compose, dueReminders, emptyState, type AppState, type Reminder } from '@automedo/core';
import type { RecordDb } from './db';

export interface PushService {
  publicKey: string;
  subscribe(sub: PushSubscription, label?: string): void;
  unsubscribe(endpoint: string): void;
  count(): number;
  /** Send to every subscribed device; drops subscriptions the push service says are gone. */
  broadcast(payload: { title: string; body: string; tag?: string; url?: string }): Promise<{ sent: number; removed: number }>;
  /** Evaluate reminders and deliver each to every device once; failures are retried with backoff. Returns reminders delivered to at least one device. */
  tick(now?: number): Promise<Reminder[]>;
  start(intervalMs?: number): void;
  stop(): void;
}

/** Give up on a reminder this long after the first failed attempt (it's stale by then). */
const RETRY_WINDOW_MS = 12 * 60 * 60_000;
/** 1, 2, 4, 8 … minutes between retries, at most an hour. */
export const backoff = (attempts: number) => Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000;

export function stateFromDb(db: RecordDb): AppState {
  return compose(db.all().map((r) => ({ id: r.id, kind: r.kind, parent: r.parent, data: r.data })), emptyState().ui);
}

export function createPush(db: RecordDb, opts: { subject?: string; sender?: typeof webpush.sendNotification } = {}): PushService {
  const raw = db.raw;
  raw.exec(`
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, sub TEXT NOT NULL, label TEXT, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS push_delivery (
      key TEXT NOT NULL, endpoint TEXT NOT NULL,
      status TEXT NOT NULL,             -- 'sent' | 'failed'
      attempts INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
      PRIMARY KEY (key, endpoint)
    );
  `);
  const getMeta = raw.prepare('SELECT v FROM meta WHERE k = ?');
  const setMeta = raw.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)');
  // Generated once and kept in the database, so subscriptions survive restarts.
  let keys = getMeta.get('vapid') as { v: string } | undefined;
  if (!keys) {
    const k = webpush.generateVAPIDKeys();
    setMeta.run('vapid', JSON.stringify(k));
    keys = { v: JSON.stringify(k) };
  }
  const vapid = JSON.parse(keys.v) as { publicKey: string; privateKey: string };
  const subject = opts.subject ?? 'mailto:automedo@example.com';
  const send = opts.sender ?? webpush.sendNotification;

  const upsertSub = raw.prepare('INSERT OR REPLACE INTO push_subs (endpoint, sub, label, created) VALUES (?, ?, ?, ?)');
  const delSub = raw.prepare('DELETE FROM push_subs WHERE endpoint = ?');
  const allSubs = raw.prepare('SELECT endpoint, sub FROM push_subs');
  const countSubs = raw.prepare('SELECT COUNT(*) AS n FROM push_subs');
  const getDelivery = raw.prepare('SELECT status, attempts, first_at, last_at FROM push_delivery WHERE key = ? AND endpoint = ?');
  const putDelivery = raw.prepare('INSERT OR REPLACE INTO push_delivery (key, endpoint, status, attempts, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?)');
  const dropDeliveries = raw.prepare('DELETE FROM push_delivery WHERE endpoint = ?');
  const options = () => ({ vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 60 * 60 * 12, urgency: 'normal' as const });

  /** Deliver one payload to one device. 'gone' means the subscription no longer exists. */
  async function deliver(endpoint: string, sub: string, payload: object): Promise<'sent' | 'gone' | 'failed'> {
    try {
      await send(JSON.parse(sub) as PushSubscription, JSON.stringify(payload), options());
      return 'sent';
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        delSub.run(endpoint); // the device unsubscribed or the app was removed
        dropDeliveries.run(endpoint);
        return 'gone';
      }
      console.error(`push to ${new URL(endpoint).host} failed:`, status ?? (e as Error).message);
      return 'failed';
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const service: PushService = {
    publicKey: vapid.publicKey,
    subscribe(sub, label) {
      upsertSub.run(sub.endpoint, JSON.stringify(sub), label ?? null, Date.now());
    },
    unsubscribe(endpoint) {
      delSub.run(endpoint);
    },
    count: () => (countSubs.get() as { n: number }).n,
    async broadcast(payload) {
      const subs = allSubs.all() as { endpoint: string; sub: string }[];
      const results = await Promise.all(subs.map((row) => deliver(row.endpoint, row.sub, payload)));
      return { sent: results.filter((r) => r === 'sent').length, removed: results.filter((r) => r === 'gone').length };
    },
    async tick(now = Date.now()) {
      if (running || service.count() === 0) return [];
      running = true;
      try {
        const subs = allSubs.all() as { endpoint: string; sub: string }[];
        const delivered: Reminder[] = [];
        for (const r of dueReminders(stateFromDb(db), now)) {
          const payload = { title: r.title, body: r.body, tag: r.key, url: r.wsId ? `./?ws=${encodeURIComponent(r.wsId)}` : './' };
          let any = false;
          // Tracked per device: a success is never repeated, a failure is retried with backoff.
          for (const s of subs) {
            const d = getDelivery.get(r.key, s.endpoint) as { status: string; attempts: number; first_at: number; last_at: number } | undefined;
            if (d?.status === 'sent') continue;
            if (d && now - d.first_at > RETRY_WINDOW_MS) continue; // stale: give up
            if (d && now - d.last_at < backoff(d.attempts)) continue; // wait before retrying
            const result = await deliver(s.endpoint, s.sub, payload);
            if (result === 'gone') continue;
            putDelivery.run(r.key, s.endpoint, result, (d?.attempts ?? 0) + 1, d?.first_at ?? now, now);
            if (result === 'sent') any = true;
          }
          if (any) delivered.push(r);
        }
        return delivered;
      } finally {
        running = false;
      }
    },
    start(intervalMs = 60_000) {
      service.stop();
      timer = setInterval(() => void service.tick().catch((e) => console.error('reminder tick failed:', e)), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return service;
}
