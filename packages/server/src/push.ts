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
  /** Evaluate reminders against the current data and send the ones not sent yet. */
  tick(now?: number): Promise<Reminder[]>;
  start(intervalMs?: number): void;
  stop(): void;
}

export function stateFromDb(db: RecordDb): AppState {
  return compose(db.all().map((r) => ({ id: r.id, kind: r.kind, parent: r.parent, data: r.data })), emptyState().ui);
}

export function createPush(db: RecordDb, opts: { subject?: string; sender?: typeof webpush.sendNotification } = {}): PushService {
  const raw = db.raw;
  raw.exec(`
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, sub TEXT NOT NULL, label TEXT, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS push_sent (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
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
  const wasSent = raw.prepare('SELECT 1 FROM push_sent WHERE key = ?');
  const markSent = raw.prepare('INSERT OR IGNORE INTO push_sent (key, at) VALUES (?, ?)');

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
      let sent = 0;
      let removed = 0;
      await Promise.all(
        subs.map(async (row) => {
          try {
            await send(JSON.parse(row.sub) as PushSubscription, JSON.stringify(payload), {
              vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
              TTL: 60 * 60 * 12,
              urgency: 'normal',
            });
            sent++;
          } catch (e) {
            const status = (e as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              delSub.run(row.endpoint); // the device unsubscribed or the app was removed
              removed++;
            } else {
              console.error(`push to ${new URL(row.endpoint).host} failed:`, status ?? (e as Error).message);
            }
          }
        }),
      );
      return { sent, removed };
    },
    async tick(now = Date.now()) {
      if (running || service.count() === 0) return [];
      running = true;
      try {
        const fresh = dueReminders(stateFromDb(db), now).filter((r) => !wasSent.get(r.key));
        for (const r of fresh) {
          await service.broadcast({ title: r.title, body: r.body, tag: r.key, url: r.wsId ? `./?ws=${encodeURIComponent(r.wsId)}` : './' });
          markSent.run(r.key, now);
        }
        return fresh;
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
