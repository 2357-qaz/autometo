import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createBrowserStore, loadFromStorage } from './store';
import { createBrowserSync } from './sync';
import './styles.css';

const { state, error } = loadFromStorage();
const store = createBrowserStore(state);
const sync = createBrowserSync(store);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App store={store} sync={sync} loadError={error} />
  </StrictMode>,
);
