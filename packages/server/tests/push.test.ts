import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createECDH, randomBytes } from 'node:crypto';
import webpush from 'web-push';
// @ts-expect-error untyped dependency of web-push
import ece from 'http_ece';
import { createStore, emptyState, newSyncMeta, ops, SyncClient, type SyncMeta } from '@automedo/core';
import { createApp } from '../src/app';
import { openDb } from '../src/db';
import { createPush } from '../src/push';

const TOKEN = 'push-token-0123456789abcdef';
const sent: { endpoint: string; payload: { title: string; body: string; tag: string; url: string } }[] = [];
let failWith: number | null = null;
const db = openDb(':memory:');
const push = createPush(db, {
  sender: (async (sub: webpush.PushSubscription, payload: string) => {
    if (failWith) throw Object.assign(new Error('gone'), { statusCode: failWith });
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    return { statusCode: 201, body: '', headers: {} };
  }) as typeof webpush.sendNotification,
});
let server: Server;
let url = '';
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

// A simulated browser subscription with real P-256 keys.
const device = createECDH('prime256v1');
device.generateKeys();
const deviceAuth = randomBytes(16);
const subscription = {
  endpoint: 'https://push.example.com/send/abc123',
  keys: { p256dh: device.getPublicKey('base64url'), auth: deviceAuth.toString('base64url') },
};

beforeAll(async () => {
  server = createApp({ db, token: TOKEN, push });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('web push', () => {
  it('exposes the VAPID key and validates subscriptions', async () => {
    const key = (await (await fetch(`${url}/v1/push/key`, { headers: auth })).json()) as { publicKey: string };
    expect(key.publicKey).toBe(push.publicKey);
    expect(Buffer.from(key.publicKey, 'base64url').length).toBe(65); // uncompressed P-256 point
    const bad = await fetch(`${url}/v1/push/subscribe`, { method: 'POST', headers: auth, body: JSON.stringify({ subscription: { endpoint: 'http://evil' } }) });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${url}/v1/push/subscribe`, { method: 'POST', headers: auth, body: JSON.stringify({ subscription, label: 'iPhone' }) });
    expect(ok.status).toBe(200);
    expect(push.count()).toBe(1);
    const noAuth = await fetch(`${url}/v1/push/key`);
    expect(noAuth.status).toBe(401);
  });

  it('sends a due checkpoint reminder once, from synced data', async () => {
    // A goal created 8 days ago with a 7-day cadence, synced from a client.
    const store = createStore(emptyState());
    store.mutate('x', (d) => {
      const g = ops.createGoal(d, '学吉他', { cadenceDays: 7 });
      g.createdAt -= 8 * 86_400_000;
    });
    let meta: SyncMeta = newSyncMeta('phone');
    const client = new SyncClient(store, { loadConfig: () => ({ url, token: TOKEN }), saveConfig() {}, loadMeta: () => meta, saveMeta: (m) => void (meta = m) });
    await client.syncNow(true);

    const first = await push.tick();
    expect(first.map((r) => r.key.split(':')[0])).toEqual(['cp']);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.title).toContain('学吉他');
    expect(sent[0].payload.url).toContain('?ws=');
    expect(await push.tick()).toEqual([]); // not sent twice
    expect(sent).toHaveLength(1);
  });

  it('test endpoint broadcasts; gone subscriptions are removed', async () => {
    const r = (await (await fetch(`${url}/v1/push/test`, { method: 'POST', headers: auth })).json()) as { sent: number };
    expect(r.sent).toBe(1);
    failWith = 410;
    const r2 = (await (await fetch(`${url}/v1/push/test`, { method: 'POST', headers: auth })).json()) as { sent: number; removed: number };
    expect(r2).toEqual({ sent: 0, removed: 1 });
    expect(push.count()).toBe(0);
    failWith = null;
  });

  it('produces a payload the subscribed device can actually decrypt', () => {
    const payload = JSON.stringify({ title: '✻ 专注时间到了', body: '休息一下' });
    const details = webpush.generateRequestDetails(subscription, payload, {
      vapidDetails: { subject: 'mailto:me@example.com', publicKey: push.publicKey, privateKey: JSON.parse((db.raw.prepare("SELECT v FROM meta WHERE k = 'vapid'").get() as { v: string }).v).privateKey },
    });
    expect(details.headers['Content-Encoding']).toBe('aes128gcm');
    expect(String(details.headers.Authorization)).toMatch(/^vapid t=.+, k=/);
    const plain = ece.decrypt(details.body, { version: 'aes128gcm', privateKey: device, authSecret: deviceAuth.toString('base64url') });
    expect(JSON.parse(plain.toString('utf8')).title).toBe('✻ 专注时间到了');
  });
});

describe('reminder delivery retries', async () => {
  const { prepareSync } = await import('@automedo/core');
  const MIN = 60_000;
  function setup() {
    const db = openDb(':memory:');
    const calls: string[] = [];
    const failing = new Set<string>();
    const push = createPush(db, {
      sender: (async (sub: webpush.PushSubscription) => {
        calls.push(sub.endpoint);
        if (failing.has(sub.endpoint)) throw new Error('ECONNRESET'); // network error: no statusCode
        return { statusCode: 201, body: '', headers: {} };
      }) as typeof webpush.sendNotification,
    });
    // A goal whose checkpoint is due, written straight into the record store.
    const s = createStore(emptyState());
    s.mutate('x', (d) => void (ops.createGoal(d, '跑步', { cadenceDays: 7 }).createdAt -= 8 * 86_400_000));
    db.sync(prepareSync(s.get(), newSyncMeta('seed')).request);
    const keys = { p256dh: 'x', auth: 'y' };
    push.subscribe({ endpoint: 'https://a.example/1', keys });
    push.subscribe({ endpoint: 'https://b.example/1', keys });
    return { push, calls, failing };
  }

  it('retries a failed device with backoff, never re-sends to a device that got it', async () => {
    const { push, calls, failing } = setup();
    const T0 = Date.now();
    failing.add('https://b.example/1');
    expect((await push.tick(T0)).length).toBe(1); // delivered to A at least
    expect(calls).toEqual(['https://a.example/1', 'https://b.example/1']);
    await push.tick(T0 + 30_000); // B still inside its 1-minute backoff
    expect(calls).toHaveLength(2);
    failing.clear();
    await push.tick(T0 + 61_000); // B retried and succeeds; A not touched
    expect(calls).toEqual(['https://a.example/1', 'https://b.example/1', 'https://b.example/1']);
    await push.tick(T0 + 10 * MIN);
    expect(calls).toHaveLength(3); // nothing left to send
  });

  it('a total outage is not recorded as delivered', async () => {
    const { push, calls, failing } = setup();
    const T0 = Date.now();
    failing.add('https://a.example/1').add('https://b.example/1');
    expect(await push.tick(T0)).toEqual([]);
    failing.clear();
    expect(await push.tick(T0 + 2 * MIN)).toHaveLength(1);
    expect(calls.filter((c) => c.includes('a.example'))).toHaveLength(2);
    expect(calls.filter((c) => c.includes('b.example'))).toHaveLength(2);
  });

  it('gives up on a reminder that keeps failing for more than 12 hours', async () => {
    const { push, calls, failing } = setup();
    const T0 = Date.now();
    failing.add('https://b.example/1');
    await push.tick(T0);
    const before = calls.length;
    await push.tick(T0 + 13 * 60 * MIN);
    expect(calls.length).toBe(before); // stale: no more attempts
  });
});
