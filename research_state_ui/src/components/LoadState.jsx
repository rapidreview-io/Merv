import { Link } from 'react-router-dom';

// Last-good data is on screen and the refresh behind it failed. `error` is
// the message, kept to the tooltip so the page stays calm.
export function StaleNote({ error }) {
  return (
    <p className="stale-note" role="status" title={error || undefined}>
      Couldn’t refresh — showing the last loaded state.
    </p>
  );
}

// A record page with nothing to show: a fetch error (message + a way back),
// a 200 that carried no record, or still loading.
export function LoadFallback({ error, fetched = false, back, label, className = 'page-stage' }) {
  return (
    <div className={className}>
      {error ? (
        <>
          <div className="error-message">{error}</div>
          <Link className="btn" to={back} style={{ marginTop: 12 }}>← {label}</Link>
        </>
      ) : (
        <div className="empty">{fetched ? 'Unexpected response from server.' : 'Loading…'}</div>
      )}
    </div>
  );
}
