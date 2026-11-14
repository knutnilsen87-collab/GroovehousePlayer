// Først: velger avspillingsmotor (web/Android) og kobler /api og /media til Vault i appen.
import './lib/platform';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
