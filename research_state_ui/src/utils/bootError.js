// What the boot page says for each way GET /api/projects can fail. Pure so
// the branches are testable; `dev` gates the local-server hint. The typed
// gates only reload; everything else retries.
const BY_CODE = {
  unauthorized: { title: 'Sign-in required', body: 'The backend rejected this session. Reload to sign in again.', reload: true },
  client_too_old: { title: 'This UI is out of date', body: 'The backend requires a newer client. Reload to pick it up.', reload: true },
  not_api: {
    title: 'Backend answered, but not with the Merv API',
    body: 'Something else is answering at this address — a misrouted proxy, a captive portal, or the wrong host.',
    retry: true,
  },
};

export function bootErrorView(err, dev = false) {
  const { code, status } = err || {};
  if (BY_CODE[code]) return BY_CODE[code];
  if (status === 404) return BY_CODE.not_api;
  if (status >= 500) {
    return { title: 'Server error', body: `The backend answered ${status}. Retrying…`, retry: true };
  }
  return {
    title: 'Backend not reachable',
    body: dev ? 'Is the Merv HTTP server running on 127.0.0.1:8787?' : 'Check your connection — retrying…',
    hint: dev ? 'python3 scripts/dev_http_reload.py --host 127.0.0.1 --port 8787' : null,
    retry: true,
  };
}

// Exponential backoff for the auto-retry: 2 s, 4 s, … capped at 30 s.
export const retryDelayMs = (tries) => Math.min(30_000, 1000 * 2 ** Math.max(1, tries));
