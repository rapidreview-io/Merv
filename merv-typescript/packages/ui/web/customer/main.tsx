import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { watchStaleBuild } from '../stale-build';
import { CustomerApp } from './app';
import '@fontsource/source-serif-4/400.css';
import '@fontsource/source-serif-4/400-italic.css';
import '@fontsource/source-serif-4/600.css';
import '@fontsource/geist-sans/400.css';
import '@fontsource/geist-sans/500.css';
import '@fontsource/geist-mono/400.css';
import '../styles.css';
import './customer.css';

watchStaleBuild();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CustomerApp />
  </StrictMode>,
);
