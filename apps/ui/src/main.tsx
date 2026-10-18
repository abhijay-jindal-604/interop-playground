/** Entry point (plan/10 §1 apps/ui). Applies the stored theme before the first paint. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './tokens.css';
import './styles.css';
import { App } from './App.js';
import { applyTheme, readTheme } from './lib/theme.js';

applyTheme(readTheme());

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
