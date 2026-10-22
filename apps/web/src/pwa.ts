// PWA glue: service worker, launch parameters (?add= / ?note= / ?ws=), iOS viewport.
import { currentWs, execute, ops, type Store } from '@automedo/core';

export const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
/** Running inside the iOS app (Capacitor injects its bridge before any page script). */
export const isNativeApp = () => !!(window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();

export function registerServiceWorker(store: Store) {
  // The app ships its files itself; a service worker is neither needed nor supported there.
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || isNativeApp()) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('service worker registration failed', e));
  });
  // A tapped notification asks an already-open window to show a workspace.
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string; url?: string }>) => {
    if (e.data?.type === 'open' && e.data.url) openWsFromUrl(store, new URL(e.data.url));
  });
}

function openWsFromUrl(store: Store, url: URL) {
  const id = url.searchParams.get('ws');
  if (id) openWs(store, id);
}

/** Show a plan/goal (from a tapped notification), if it still exists. */
export function openWs(store: Store, id: string) {
  const s = store.get();
  if (s.plans.some((p) => p.id === id) || s.goals.some((g) => g.id === id)) store.mutate(null, (d) => ops.selectWs(d, id));
}

export interface LaunchResult {
  cmd: string;
  text: string;
  error?: boolean;
}

/**
 * Apply ?ws=, ?add= and ?note= (used by notifications and iOS Shortcuts), then
 * remove them from the address bar so a reload doesn't add the task twice.
 */
export function applyLaunchParams(store: Store): LaunchResult | null {
  const url = new URL(location.href);
  const add = url.searchParams.get('add');
  const note = url.searchParams.get('note');
  openWsFromUrl(store, url);
  let result: LaunchResult | null = null;
  const ctx = { store, open: () => {}, exportData: () => {}, importData: () => {}, showDiff: () => {} };
  if (add?.trim()) {
    if (!currentWs(store.get())) result = { cmd: '?add', text: '先新建或打开一个 Plan / Goal，再从快捷方式添加任务', error: true };
    else {
      const r = execute(`/task ${add.trim()}`, ctx);
      result = { cmd: '快速添加', text: r?.text ?? '', error: r?.error };
    }
  } else if (note?.trim()) {
    const r = execute(`#${note.trim()}`, ctx);
    result = { cmd: '快速记录', text: r?.text ?? '', error: r?.error };
  }
  if (url.searchParams.has('add') || url.searchParams.has('note') || url.searchParams.has('ws')) {
    ['add', 'note', 'ws'].forEach((k) => url.searchParams.delete(k));
    history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
  }
  return result;
}

/** Keep the layout the height of the *visible* viewport, so the on-screen keyboard never covers the prompt. */
export function trackVisualViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    document.documentElement.style.setProperty('--app-h', `${vv.height}px`);
    // iOS scrolls the page to reveal the focused input; our layout already does that.
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}
