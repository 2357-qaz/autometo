// iOS app glue (Capacitor). Loaded only inside the native shell (see main.tsx), so the
// web/PWA bundle does not carry it.
//
// - The state document in localStorage is mirrored to a file the app owns: iOS may clear
//   a web view's storage when the device is short of space; the file brings it back.
// - A small snapshot (core's glance) feeds the home/lock screen widget and the Live
//   Activity of a running session.
// - Reminders are scheduled ahead as local notifications (no server needed).
import { registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { documentError, glance, reminderSchedule, type ScheduledReminder, type Store } from '@automedo/core';
import { STORAGE_KEY } from './store';
import { openWs } from './pwa';

interface AutomedoNative {
  loadBackup(): Promise<{ text?: string }>;
  saveBackup(o: { text: string }): Promise<void>;
  /** Keep a copy that must not be lost (an unreadable document, a backup about to be replaced). */
  saveAside(o: { text: string; label: string }): Promise<void>;
  /** Widget data (JSON of a Glance); the native side reloads the widgets. */
  setGlance(o: { json: string }): Promise<void>;
  /** Start / update / end the Live Activity from a Glance (its session, if any). */
  syncActivity(o: { json: string }): Promise<void>;
}

const Native = registerPlugin<AutomedoNative>('AutomedoNative');

const readable = (text: string | null | undefined): text is string => !!text && documentError(text) === null;

export interface Restore {
  restored: boolean;
  /** Where the unreadable web view copy was put aside, if there was one. */
  parked?: string;
}

/**
 * Before the store loads. The web view's document wins whenever it is readable (it is
 * written first; the file follows it). If it is missing or unreadable and the app's file
 * is readable, the file is put back, after keeping the unreadable copy aside: if that
 * copy cannot be kept anywhere, nothing is replaced.
 */
export async function restoreBackup(): Promise<Restore> {
  let local: string | null;
  try {
    local = localStorage.getItem(STORAGE_KEY);
  } catch {
    return { restored: false };
  }
  if (readable(local)) return { restored: false };
  let backup: string | undefined;
  try {
    backup = (await Native.loadBackup()).text;
  } catch (e) {
    console.warn('reading the app backup failed', e);
    return { restored: false };
  }
  if (!readable(backup)) return { restored: false };
  let parked: string | undefined;
  if (local) {
    try {
      await Native.saveAside({ text: local, label: 'webview-unreadable' });
      parked = 'App 文件（Application Support/AuTomeDo/aside）';
    } catch {
      try {
        const key = `${STORAGE_KEY}.corrupt.${Date.now()}`;
        localStorage.setItem(key, local);
        parked = key;
      } catch {
        return { restored: false }; // the only copy of it: leave it for loadFromStorage
      }
    }
  }
  try {
    localStorage.setItem(STORAGE_KEY, backup);
  } catch (e) {
    console.warn('restoring the app backup failed', e);
    return { restored: false };
  }
  return { restored: true, parked };
}

/** Notification ids are 32-bit ints: derive them from the reminder key. */
export function notificationId(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return (h >>> 1) || 1;
}

/**
 * Make the pending notifications match `list`. True once they do; false (try again later)
 * without permission, e.g. until it is allowed in Settings. Scheduling an id that is
 * already pending replaces it, so the new ones go in first and only then the ones no longer
 * wanted are cancelled: a failure in between leaves extra reminders, never none.
 */
async function syncReminders(list: ScheduledReminder[]): Promise<boolean> {
  let perm = await LocalNotifications.checkPermissions();
  if (perm.display === 'prompt' || perm.display === 'prompt-with-rationale') {
    if (!list.length) return true; // ask only once there is something to remind of
    perm = await LocalNotifications.requestPermissions();
  }
  if (perm.display !== 'granted') return false;
  const wanted = list.map((r) => ({
    id: notificationId(r.key),
    title: r.title,
    body: r.body,
    schedule: { at: new Date(r.at), allowWhileIdle: true },
    extra: { automedo: true, key: r.key, wsId: r.wsId },
  }));
  if (wanted.length) await LocalNotifications.schedule({ notifications: wanted });
  const keep = new Set(wanted.map((n) => n.id));
  const stale = (await LocalNotifications.getPending()).notifications.filter((n) => n.extra?.automedo && !keep.has(n.id));
  if (stale.length) await LocalNotifications.cancel({ notifications: stale.map((n) => ({ id: n.id })) });
  return true;
}

const without = (g: ReturnType<typeof glance>) => JSON.stringify({ ...g, at: 0, used: 0, session: g.session && { ...g.session, tokens: 0 } });

/**
 * @param loadFailed the stored state could not be loaded this time: the app's backup is not
 *   replaced before a copy of it has been kept aside (or, if it cannot even be read, at all).
 */
export function attachNative(store: Store, { loadFailed = false } = {}) {
  let lastBackup = '';
  let lastGlance = '';
  let remindersDone = '';
  let backupAllowed = !loadFailed;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const mirror = async () => {
    store.flush();
    const text = localStorage.getItem(STORAGE_KEY);
    // Only a readable document may replace the backup.
    if (!readable(text) || text === lastBackup) return;
    if (!backupAllowed) {
      const { text: previous } = await Native.loadBackup(); // throws: never overwrite what could not be read
      if (previous) await Native.saveAside({ text: previous, label: 'backup-before-failed-load' });
      backupAllowed = true;
    }
    await Native.saveBackup({ text });
    lastBackup = text;
  };

  const surfaces = async (force: boolean) => {
    const g = glance(store.get());
    // Token counts move every minute; anything else is a real change.
    if (!force && without(g) === lastGlance) return;
    const json = JSON.stringify(g);
    await Native.setGlance({ json });
    await Native.syncActivity({ json });
    lastGlance = without(g);
  };

  const reminders = async () => {
    const list = reminderSchedule(store.get());
    const sig = JSON.stringify(list.map((r) => [r.key, r.at, r.title, r.body]));
    if (sig === remindersDone) return;
    if (await syncReminders(list)) remindersDone = sig; // otherwise: retried on the next round
  };

  const push = async (force = false) => {
    timer = undefined;
    // Independent: one failing must not hold up the others.
    for (const [name, step] of [['backup', mirror], ['widget', () => surfaces(force)], ['reminders', reminders]] as const) {
      try {
        await step();
      } catch (e) {
        console.warn(`native ${name} failed`, e);
      }
    }
  };
  const soon = () => {
    if (!timer) timer = setTimeout(() => void push(), 600);
  };

  store.subscribe(soon);
  // While the app is open, refresh tokens on the widget and the Live Activity every minute.
  setInterval(() => void push(true), 60_000);
  // Leaving: save everything now. Coming back (e.g. from Settings after allowing notifications): catch up.
  document.addEventListener('visibilitychange', () => void push(true));
  void LocalNotifications.addListener('localNotificationActionPerformed', (a) => {
    const id = a.notification.extra?.wsId;
    if (typeof id === 'string') openWs(store, id);
  });
  return push(true);
}
