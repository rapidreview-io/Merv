import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app';
import { watchStaleBuild } from './stale-build';
// The admin page's styles, in the bundle's order as before, from here so tests can load the view.
import './views/admin.css';
import './styles.css';

watchStaleBuild();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename="/ui">
      <App />
    </BrowserRouter>
  </StrictMode>,
);
