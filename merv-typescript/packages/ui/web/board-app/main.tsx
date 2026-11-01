import './as-board';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { hasToken, setProject, setToken } from '../api';
import '../styles.css';
import './board-app.css';
import { BoardApp } from './app';

const SharedBoard = lazy(() => import('../views/board-shared'));
const shared = window.location.pathname === '/ui/board-share';

/** One person on their own computer signs in by being there: the server says so, or 404s. */
async function solo() {
  if (shared || hasToken()) return;
  const given = await fetch('/board-solo', { credentials: 'omit' })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  if (!given) return;
  setToken(given.token);
  setProject(given.projectId);
}

void solo().then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter basename="/ui">
        <Suspense fallback={null}>{shared ? <SharedBoard /> : <BoardApp />}</Suspense>
      </BrowserRouter>
    </StrictMode>,
  ),
);
