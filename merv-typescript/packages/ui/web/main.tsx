import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { drillIn, safely } from './api';
import { App } from './app';
import { watchStaleBuild } from './stale-build';
import './styles.css';

watchStaleBuild();
// A sign-in's callback lands on the root; it goes on, with its code, to the page it began on.
const { pathname, search, hash } = window.location;
const back = safely(() => sessionStorage.getItem('merv:return'));
const callback = !!back && /[?&#](code|access_token)=/.test(search + hash);
if (callback) safely(() => sessionStorage.removeItem('merv:return'));
const leaving = callback && back !== pathname;
// Leaving draws nothing: the page it goes on to exchanges the code, and only once.
if (leaving) window.location.replace(back + search + hash);
else {
  // The admin's drill-in keeps every path a page links to inside its project's own address.
  const base = drillIn(window.location.pathname) ?? '/ui';
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter basename={base}>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
}
