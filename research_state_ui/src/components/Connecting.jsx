import { useEffect, useState } from 'react';

export function FullPageStatus({ children }) {
  return (
    <div className="page-stage" style={{ display: 'flex', alignItems: 'center', minHeight: '80vh' }}>
      <div className="empty-state" style={{ textAlign: 'left' }}>{children}</div>
    </div>
  );
}

// Boot frame: says so at once, and offers a way out once the page has waited
// ~10 s in total (a backend that accepts the socket and never answers). Timed
// from page load, not mount — AuthGate and App each show one in turn.
export default function Connecting() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), Math.max(0, 10_000 - performance.now()));
    return () => clearTimeout(t);
  }, []);
  return (
    <FullPageStatus>
      <p>Connecting to Merv…</p>
      {slow && (
        <p>
          Still waiting for the backend.{' '}
          <button className="btn" onClick={() => window.location.reload()}>Reload</button>
        </p>
      )}
    </FullPageStatus>
  );
}
