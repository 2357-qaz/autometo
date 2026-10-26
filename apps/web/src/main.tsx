import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createBrowserStore, loadFromStorage } from './store';
import { createBrowserSync } from './sync';
import { applyLaunchParams, isNativeApp, registerServiceWorker, trackVisualViewport } from './pwa';
import './styles.css';

async function boot() {
  // In the iOS app, the native glue loads first: it may restore the state from its file copy.
  const native = isNativeApp() ? await import('./native') : null;
  const restore = native ? await native.restoreBackup() : null;
  const { state, error } = loadFromStorage();
  const store = createBrowserStore(state);
  const sync = createBrowserSync(store);
  const restored = restore?.restored
    ? { cmd: '恢复数据', text: restore.parked ? `网页存储里的数据读不出来，已从 App 的备份恢复；读不出的那份保存在 ${restore.parked}` : '网页存储被清空了，已从 App 的备份恢复' }
    : null;
  const launch = applyLaunchParams(store) ?? restored;
  registerServiceWorker(store);
  trackVisualViewport();
  void native?.attachNative(store, { loadFailed: !!error });

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App store={store} sync={sync} loadError={error} launch={launch} />
    </StrictMode>,
  );
}

void boot();
