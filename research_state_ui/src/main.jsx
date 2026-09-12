import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import AuthGate from './components/AuthGate.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import './styles/global.css';
import './styles/mobile.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename="/merv">
      {/* AuthGate holds the app until /api/meta answers; hosted mode signs in
          first so App's boot requests already carry the session token. */}
      <ErrorBoundary>
        <AuthGate>
          <App />
        </AuthGate>
      </ErrorBoundary>
    </BrowserRouter>
  </React.StrictMode>,
);
