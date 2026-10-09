import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createStore, loadFromStorage } from './store';
import './styles.css';

const { state, error } = loadFromStorage();
const store = createStore(state);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App store={store} loadError={error} />
  </StrictMode>,
);
