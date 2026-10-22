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
import { glance, reminderSchedule, type ScheduledReminder, type Store } from '@automedo/core';
import { STORAGE_KEY } from './store';
import { openWs } from './pwa';

interface AutomedoNative {
  loadBackup(): Promise<{ text?: string }>;
  saveBackup(o: { text: string }): Promise<void>;
  /** Widget data (JSON of a Glance); the native side reloads the widgets. */
  setGlance(o: { json: string }): Promise<void>;
  /** Start / update / end the Live Activity from a Glance (its session, if any). */
  syncActivity(o: { json: string }): Promise<void>;
}

const Native = registerPlugin<AutomedoNative>('AutomedoNative');

/** Before the store loads: if the web view's storage was cleared, put the mirrored copy back. */
export async function restoreBackup(): Promise<boolean> {
  try {
    if (localStorage.getItem(STORAGE_KEY)) return false;
    const { text } = await Native.loadBackup();
    if (!text) return false;
    localStorage.setItem(STORAGE_KEY, text);
    return true;
  } catch (e) {
    console.warn('restoring the app backup failed', e);
    return false;
  }
}

/** Notification ids are 32-bit ints: derive them from the reminder key. */
function notificationId(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return (h >>> 1) || 1;
}

async function scheduleReminders(list: ScheduledReminder[]) {
  let perm = await LocalNotifications.checkPermissions();
  if (perm.display === 'prompt' || perm.display === 'prompt-with-rationale') {
    if (!list.length) return; // ask only once there is something to remind of
    perm = await LocalNotifications.requestPermissions();
  }
  if (perm.display !== 'granted') return;
  // Replace what this app scheduled before (only ours: they carry extra.automedo).
  const pending = (await LocalNotifications.getPending()).notifications.filter((n) => n.extra?.automedo);
  if (pending.length) await LocalNotifications.cancel({ notifications: pending.map((n) => ({ id: n.id })) });
  if (!list.length) return;
  await LocalNotifications.schedule({
    notifications: list.map((r) => ({
      id: notificationId(r.key),
      title: r.title,
      body: r.body,
      schedule: { at: new Date(r.at), allowWhileIdle: true },
      extra: { automedo: true, key: r.key, wsId: r.wsId },
    })),
  });
}

const without = (g: ReturnType<typeof glance>) => JSON.stringify({ ...g, at: 0, used: 0, session: g.session && { ...g.session, tokens: 0 } });

export function attachNative(store: Store) {
  let lastBackup = '';
  let lastGlance = '';
  let lastReminders = '';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const push = async (force = false) => {
    timer = undefined;
    try {
      store.flush();
      const text = localStorage.getItem(STORAGE_KEY);
      if (text && text !== lastBackup) {
        await Native.saveBackup({ text });
        lastBackup = text;
      }
      const state = store.get();
      const g = glance(state);
      const json = JSON.stringify(g);
      // Token counts move every minute; anything else is a real change.
      if (force || without(g) !== lastGlance) {
        lastGlance = without(g);
        await Native.setGlance({ json });
        await Native.syncActivity({ json });
      }
      const reminders = reminderSchedule(state);
      const sig = JSON.stringify(reminders.map((r) => [r.key, r.at, r.title]));
      if (sig !== lastReminders) {
        lastReminders = sig;
        await scheduleReminders(reminders);
      }
    } catch (e) {
      console.warn('native sync failed', e);
    }
  };
  const soon = () => {
    if (!timer) timer = setTimeout(() => void push(), 600);
  };

  store.subscribe(soon);
  // While the app is open, refresh tokens on the widget and the Live Activity every minute.
  setInterval(() => void push(true), 60_000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void push(true));
  void LocalNotifications.addListener('localNotificationActionPerformed', (a) => {
    const id = a.notification.extra?.wsId;
    if (typeof id === 'string') openWs(store, id);
  });
  void push(true);
}
