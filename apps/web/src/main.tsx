import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createBrowserStore, loadFromStorage } from './store';
import './styles.css';

const { state, error } = loadFromStorage();
const store = createBrowserStore(state);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App store={store} loadError={error} />
  </StrictMode>,
);
