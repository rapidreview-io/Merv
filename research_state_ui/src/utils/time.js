// Everything that turns a timestamp into words. `format.js` owns the pure
// ms → string ladders; this owns the parsing, the clock, and the calendar.
// An unparseable stamp never renders "Invalid Date": it comes back null (or
// the caller's fallback) so the line can simply be dropped.
import { fmtAgo, fmtDayTime } from './format.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

// ISO → epoch ms, 0 when unparseable, so callers can sort/compare on it.
export function tsMs(ts) {
  const v = Date.parse(ts);
  return Number.isFinite(v) ? v : 0;
}

// ISO → "3h ago"; null when unparseable.
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? fmtAgo(now - t) : null;
}

// Span between two ISO stamps, never negative; null when either is unparseable.
export function msBetween(a, b) {
  const t0 = Date.parse(a || ''), t1 = Date.parse(b || '');
  return Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, t1 - t0) : null;
}

// "Jul 5, 06:03 PM" — the compact absolute stamp cards and ledgers scan.
export function shortDateTime(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// "Jul 5" — the year appears only when it isn't this one.
export function fmtDay(iso) {
  return fmtDayTime(iso)?.day ?? null;
}

// "Jul 23 · 6:03 PM" — an absolute day plus its clock.
export function dayTime(iso) {
  const d = fmtDayTime(iso);
  return d ? `${d.day} · ${d.time}` : null;
}

// "Jul 5 · 41d ago" — a day the reader can place, and the distance to it.
export function dayAgo(iso, now = Date.now()) {
  const day = fmtDay(iso);
  if (!day) return null;
  const rel = ago(iso, now);
  return rel ? `${day} · ${rel}` : day;
}

// Countdown to a future stamp — "45s", "12m", "3h", "2d". `fallback` is what
// an unparseable stamp reads as, because the callers word that differently.
export function until(iso, now = Date.now(), fallback = 'unknown') {
  const ts = Date.parse(iso || '');
  if (!Number.isFinite(ts)) return fallback;
  const s = Math.max(0, Math.floor((ts - now) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// "today" / "yesterday" / "12d ago" — the calm relative stamp for ledger rows.
export function relDays(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const days = Math.floor((now - t) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

const p2 = (n) => String(n).padStart(2, '0');

// Local-time calendar day as "YYYY-MM-DD", matching the local-time labels the
// cards render. Compared for grouping, and parsed back for axis ticks.
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
