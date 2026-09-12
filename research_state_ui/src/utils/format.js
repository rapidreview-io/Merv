// Shared display formatters. Keep these dumb and dependency-free.

// Money reads at cents until $100, whole dollars after — the jitter of live
// billing isn't worth two decimals at that magnitude.
export function fmtUsd(v) {
  if (!Number.isFinite(v)) return '—';
  const digits = v >= 100 ? 0 : 2;
  return '$' + v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// Compute-hours: minutes under an hour, one decimal until 100 h.
export function fmtHrs(v) {
  if (!Number.isFinite(v)) return '—';
  if (v < 1) return `${Math.round(v * 60)} min`;
  return `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))} h`;
}

export function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  let v = n / 1024;
  for (const u of ['KB', 'MB', 'GB', 'TB']) {
    if (v < 1024 || u === 'TB') return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u}`;
    v /= 1024;
  }
}

// Compact absolute stamp for chronological scanning ("Jul 1, 21:05").
// 24-hour on purpose: fixed width, sorts visually.
export function fmtStamp(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function tsToTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return iso; }
}

export function fmtAgo(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// Coarse human span for graph cards and sidebars ("4d 15h", "34m", "<1m"):
// two units at most, and the trailing zero unit dropped ("4d", not "4d 0h").
// Returns null for anything unparseable so callers can simply omit it.
export function fmtSpan(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.floor(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

// Split timestamp for compact two-line table cells: "Jun 11" over "1:36 PM".
export function fmtDayTime(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return {
    day: d.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
    }),
    time: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  };
}

export function isMarkdown(path) {
  const ext = (path || '').split('.').pop().toLowerCase();
  return ext === 'md' || ext === 'markdown' || ext === 'mdx';
}

// A class list from parts, dropping the falsy ones:
//   cx('row', open && 'is-open', className)
export function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

// The last non-empty path segment ("runs/2/loss.svg" -> "loss.svg").
export function basename(p) {
  return (p || '').split('/').filter(Boolean).pop() || p || '';
}

// A file's lowercase extension, from the last dot of the last segment; '' when
// the name has no dot (a dotted directory never leaks into the answer).
export function extOf(path) {
  if (!path) return '';
  const name = path.split('/').pop() || '';
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

// Trim to n characters with an ellipsis in the nth slot.
export function clip(s, n) {
  const t = (s || '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// A typed-in pairing / device code: upper case, digits and letters only, the
// eight characters the backend issues.
export function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
}

// A commit, abbreviated the way git abbreviates it.
export function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : '';
}

// A link's display host, www- stripped; '' when the string isn't a URL.
export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Copy for a /content envelope with `available: false`. A complete row whose
// bytes are gone (blob store lost the file) is a different fact from a role
// nobody has submitted yet; the recorded size tells them apart.
export function unavailableCopy(content, what = 'this artifact') {
  return content?.size_bytes
    ? `Stored bytes for ${what} are missing (${formatBytes(content.size_bytes)} recorded).`
    : `No submitted content is available for ${what} yet.`;
}
