import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { watchStaleBuild } from '../stale-build';
import { CustomerApp } from './app';
import '../styles.css';
import './customer.css';

watchStaleBuild();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CustomerApp />
  </StrictMode>,
);
