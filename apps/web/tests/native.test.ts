// The iOS glue (src/native.ts) against fake Capacitor plugins, a Map-backed localStorage
// and a minimal document: the backup must never be replaced by something worse, and
// reminders must end up scheduled even when the first attempts fail.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  file: undefined as string | undefined,
  aside: [] as { text: string; label: string }[],
  failAside: false,
  failLoad: false,
  loadBackup: async () => {
    if (native.failLoad) throw new Error('bridge down');
    return { text: native.file };
  },
  saveBackup: async ({ text }: { text: string }) => void (native.file = text),
  saveAside: async (o: { text: string; label: string }) => {
    if (native.failAside) throw new Error('disk full');
    native.aside.push(o);
  },
  setGlance: async () => {},
  syncActivity: async () => {},
}));

const notes = vi.hoisted(() => ({
  permission: 'prompt' as string,
  answer: 'granted' as string,
  pending: [] as { id: number; title: string; extra?: Record<string, unknown> }[],
  failSchedule: 0,
  checkPermissions: async () => ({ display: notes.permission }),
  requestPermissions: async () => ((notes.permission = notes.answer), { display: notes.permission }),
  schedule: async ({ notifications }: { notifications: { id: number; title: string; extra?: Record<string, unknown> }[] }) => {
    if (notes.failSchedule > 0) {
      notes.failSchedule--;
      throw new Error('schedule failed');
    }
    for (const n of notifications) notes.pending = [...notes.pending.filter((p) => p.id !== n.id), n]; // same id replaces
  },
  getPending: async () => ({ notifications: notes.pending }),
  cancel: async ({ notifications }: { notifications: { id: number }[] }) => {
    const ids = new Set(notifications.map((n) => n.id));
    notes.pending = notes.pending.filter((p) => !ids.has(p.id));
  },
  addListener: async () => ({ remove: async () => {} }),
}));

vi.mock('@capacitor/core', () => ({ registerPlugin: () => native }));
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: notes }));

const storage = new Map<string, string>();
const listeners: (() => void)[] = [];
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  },
  document: { visibilityState: 'visible', addEventListener: (_: string, f: () => void) => listeners.push(f) },
  window: { addEventListener: () => {} },
});

const { createStore, ops, seedDemo, emptyState } = await import('@automedo/core');
const STORAGE_KEY = 'automedo.v0';

/** Fresh modules for each run: src/store.ts keeps per-page state (e.g. a write block). */
async function app() {
  vi.resetModules();
  return { ...(await import('../src/native')), ...(await import('../src/store')) };
}

/** A readable document, as the web app writes it. */
function goodDoc(title: string) {
  const s = emptyState();
  ops.createPlan(s, title);
  return JSON.stringify({ ...s, writeSeq: 1 });
}
const CORRUPT = '{"version":1,"plans":[{"id":"p1","title":"写到一半';

beforeEach(() => {
  storage.clear();
  listeners.length = 0;
  Object.assign(native, { file: undefined, aside: [], failAside: false, failLoad: false });
  Object.assign(notes, { permission: 'prompt', answer: 'granted', pending: [], failSchedule: 0 });
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T09:00:00'));
});
afterEach(() => vi.useRealTimers());

// The real startup order of main.tsx.
async function boot() {
  const { restoreBackup, loadFromStorage, createBrowserStore, attachNative } = await app();
  const restore = await restoreBackup();
  const { state, error } = loadFromStorage();
  const store = createBrowserStore(state);
  await attachNative(store, { loadFailed: !!error });
  return { restore, store, error };
}

describe('backup', () => {
  it('a corrupt web view document does not overwrite a good backup: the backup is restored', async () => {
    native.file = goodDoc('好的备份 B');
    storage.set(STORAGE_KEY, CORRUPT);
    const { restore, store, error } = await boot();
    expect(restore.restored).toBe(true);
    expect(error).toBeNull();
    expect(store.get().plans.map((p) => p.title)).toEqual(['好的备份 B']);
    expect(native.aside).toEqual([{ text: CORRUPT, label: 'webview-unreadable' }]); // kept, not thrown away
    expect(JSON.parse(native.file!).plans[0].title).toBe('好的备份 B');
  });

  it('if the corrupt copy cannot be kept anywhere, nothing is replaced and the backup is left alone', async () => {
    const good = goodDoc('好的备份 B');
    native.file = good;
    native.failAside = true;
    storage.set(STORAGE_KEY, CORRUPT);
    const real = localStorage.setItem;
    localStorage.setItem = () => {
      throw new Error('quota');
    };
    try {
      const { restore, error } = await boot();
      expect(restore.restored).toBe(false);
      expect(error).toMatch(/读取失败/);
    } finally {
      localStorage.setItem = real;
    }
    expect(storage.get(STORAGE_KEY)).toBe(CORRUPT);
    expect(native.file).toBe(good);
  });

  it('a readable web view document wins and replaces the (older) backup', async () => {
    native.file = goodDoc('旧备份');
    storage.set(STORAGE_KEY, goodDoc('新的'));
    const { restore, store } = await boot();
    expect(restore.restored).toBe(false);
    expect(store.get().plans[0].title).toBe('新的');
    expect(JSON.parse(native.file!).plans[0].title).toBe('新的');
  });

  it('after a failed load with an unusable backup, the old backup is kept aside before the first overwrite', async () => {
    native.file = 'not json either';
    storage.set(STORAGE_KEY, CORRUPT);
    const { restore, store, error } = await boot();
    expect([restore.restored, !!error]).toEqual([false, true]);
    expect(native.file).toBe('not json either'); // nothing readable to write yet
    store.mutate('x', (d) => void ops.createPlan(d, '重新开始'));
    await vi.advanceTimersByTimeAsync(700);
    expect(native.aside.map((a) => [a.label, a.text])).toEqual([['backup-before-failed-load', 'not json either']]);
    expect(JSON.parse(native.file!).plans[0].title).toBe('重新开始');
  });

  it('after a failed load, a backup that cannot even be read is never overwritten', async () => {
    native.file = 'unknown';
    native.failLoad = true;
    storage.set(STORAGE_KEY, CORRUPT);
    const { store } = await boot();
    store.mutate('x', (d) => void ops.createPlan(d, '新计划'));
    await vi.advanceTimersByTimeAsync(61_000);
    expect(native.file).toBe('unknown');
  });

  it('only ever mirrors readable documents', async () => {
    storage.set(STORAGE_KEY, goodDoc('甲'));
    await boot();
    const before = native.file;
    storage.set(STORAGE_KEY, CORRUPT); // something scribbled over it mid-session
    await vi.advanceTimersByTimeAsync(61_000);
    expect(native.file).toBe(before);
  });
});

describe('reminders', () => {
  async function withSession() {
    const s = emptyState();
    seedDemo(s);
    const store = createStore(s);
    store.mutate('x', (d) => {
      if (!ops.requireWsSafe(d)) return;
      ops.startSession(d, { intent: '写作', plannedMin: 30, tier: 'sonnet', effort: 'medium' });
    });
    return store;
  }

  it('denied at first, allowed later in Settings: scheduled when the app comes back', async () => {
    notes.answer = 'denied';
    const store = await withSession();
    const { attachNative } = await app();
    await attachNative(store);
    expect(notes.pending).toEqual([]);
    notes.permission = 'granted'; // the user allows notifications in Settings
    listeners.forEach((f) => f()); // and returns to the app
    await vi.advanceTimersByTimeAsync(0);
    expect(notes.pending.map((n) => n.title)).toContain('✻ 专注时间到了');
  });

  it('a failed schedule keeps the old reminders and is retried', async () => {
    notes.permission = 'granted';
    const store = await withSession();
    const { attachNative } = await app();
    await attachNative(store);
    const first = notes.pending.map((n) => n.id).sort();
    expect(first.length).toBeGreaterThan(0);
    // The plan changes (a reminder changes); scheduling fails once.
    notes.failSchedule = 1;
    store.mutate('x', (d) => void ops.endSession(d, {}));
    await vi.advanceTimersByTimeAsync(700);
    expect(notes.pending.map((n) => n.id).sort()).toEqual(first); // nothing cancelled
    await vi.advanceTimersByTimeAsync(60_000); // the next round retries
    expect(notes.pending.map((n) => n.title)).not.toContain('✻ 专注时间到了');
  });
});
