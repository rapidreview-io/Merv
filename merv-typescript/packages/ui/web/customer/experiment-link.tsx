import { useRef, useState } from 'react';
import { currentCredentials } from './api';

/** Include the private capability stripped from the address bar during sign-in. */
export function ExperimentLink({
  submitted = false,
  sent = false,
}: {
  submitted?: boolean;
  sent?: boolean;
}) {
  const credentials = currentCredentials();
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState('');
  if (!credentials) return null;
  const url = new URL(`/customer-experiments/r/${credentials.request}`, location.origin);
  url.hash = new URLSearchParams({ token: credentials.capability }).toString();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url.href);
      setMessage('Copied');
    } catch {
      input.current?.focus();
      input.current?.select();
      setMessage('Select and copy the URL above.');
    }
  };
  return (
    <aside
      className={`cx-experiment-link${submitted ? ' cx-experiment-link--submitted' : ''}`}
      aria-label={submitted ? 'Experiment submitted' : 'Experiment URL'}
    >
      {submitted && <p>{sent ? 'Link sent to your email.' : 'Sending link…'}</p>}
      <label>
        Experiment URL
        <input
          ref={input}
          className="input"
          readOnly
          value={url.href}
          onFocus={(event) => event.target.select()}
        />
      </label>
      <button type="button" className="btn" onClick={() => void copy()}>
        Copy URL
      </button>
      <span role="status">{message}</span>
    </aside>
  );
}
