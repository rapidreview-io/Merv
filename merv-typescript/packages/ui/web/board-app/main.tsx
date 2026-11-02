import './as-board';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { hasToken, setProject, setToken } from '../api';
import '../styles.css';
import './board-app.css';
import { BoardApp } from './app';
import { Landing } from './landing';

const SharedBoard = lazy(() => import('../views/board-shared'));
const shared = window.location.pathname === '/ui/board-share';
/** The landing page as someone signed out sees it, from anywhere: without the way in, on a computer. */
const looking = window.location.pathname === '/ui/welcome';

/** One person on their own computer signs in by being there: the server says so, or 404s. */
async function solo() {
  if (shared || looking || hasToken()) return;
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
        <Suspense fallback={null}>
          {shared ? <SharedBoard /> : looking ? <Landing google={null} /> : <BoardApp />}
        </Suspense>
      </BrowserRouter>
    </StrictMode>,
  ),
);
