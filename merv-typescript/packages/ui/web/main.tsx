import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { drillIn } from './api';
import { App } from './app';
import { watchStaleBuild } from './stale-build';
import './styles.css';

watchStaleBuild();
// The admin's drill-in keeps every path a page links to inside its project's own address.
const base = drillIn(window.location.pathname) ?? '/ui';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={base}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
