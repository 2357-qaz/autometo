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
  const restored = native ? await native.restoreBackup() : false;
  const { state, error } = loadFromStorage();
  const store = createBrowserStore(state);
  const sync = createBrowserSync(store);
  const launch = applyLaunchParams(store) ?? (restored ? { cmd: '恢复数据', text: 'iOS 清理了网页存储，已从 App 的备份文件恢复' } : null);
  registerServiceWorker(store);
  trackVisualViewport();
  native?.attachNative(store);

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App store={store} sync={sync} loadError={error} launch={launch} />
    </StrictMode>,
  );
}

void boot();
