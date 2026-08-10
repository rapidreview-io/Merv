/**
 * braidModel — pure join/layout model for the project braid: reflection waves
 * as epochs on a horizontal spine, experiments as strands that fan out of the
 * wave that proposed them (materialized_experiments) and consolidate into the
 * wave whose corpus delta absorbed them. No JSX here — same discipline as
 * waveModel.js so a mobile surface can reuse it later.
 */

import { TERMINAL_WAVE } from './waveModel.js';

const TERMINAL_EXP = new Set(['complete', 'failed', 'abandoned']);

// Strand tone is LIFECYCLE, deliberately not supports/refutes — evidence
// direction is not a modeled field yet (classifyExperiment's complete→supports
// mapping is a known lie); when it becomes real data, swap tones here only.
export function strandTone(status) {
  const s = String(status || '');
  if (s === 'complete') return 'done';
  if (s === 'failed') return 'failed';
  if (s === 'abandoned') return 'abandoned';
  if (s === 'running') return 'live';
  return 'queued'; // planned / ready_to_run / design_review / experiment_review
}

function idOf(row) {
  if (row == null) return null;
  if (typeof row === 'string') return row;
  return row.id || row.experiment_id || null;
}

// The experiments a wave consolidated = the corpus DELTA, not the cumulative
// snapshot (corpus.terminal_experiments carries every terminal experiment at
// wave creation, so cumulative edges would fan every strand into every later
// wave). Prefer the explicit delta; fall back to subtracting the previous
// wave's snapshot for payloads that predate new_terminal_experiments.
export function coveredDelta(wave, prevWave) {
  const corpus = wave?.corpus || {};
  const delta = corpus.new_terminal_experiments;
  if (Array.isArray(delta)) return delta.map(idOf).filter(Boolean);
  const prev = new Set(
    (prevWave?.corpus?.terminal_experiments || []).map(idOf).filter(Boolean),
  );
  return (corpus.terminal_experiments || [])
    .map(idOf)
    .filter(id => id && !prev.has(id));
}

/**
 * Join waves + (optionally) the live experiment list into braid entities.
 *
 * Returns { epochs, strands }:
 *   epochs[i]  = { id, ordinal, status, title, attemptIndex, revisionContext,
 *                  publishedAt, createdAt, isOpen }
 *   strands[j] = { id, name, status, tone, attemptIndex,
 *                  spawnedBy: waveId|null, coveredBy: waveId|null,
 *                  spawnIdx, coverIdx }   (indices into epochs, -1 = none)
 */
export function buildBraid(waves, experiments) {
  const ws = Array.isArray(waves) ? waves : [];
  const epochs = ws.map((w, i) => ({
    id: w.id,
    ordinal: i + 1,
    status: String(w.status || ''),
    title: w.title || `Wave ${i + 1}`,
    attemptIndex: w.attempt_index || 1,
    revisionContext: w.revision_context || '',
    publishedAt: w.published_at || null,
    createdAt: w.created_at || null,
    isOpen: !TERMINAL_WAVE.has(String(w.status || '')),
  }));
  const waveIdx = new Map(epochs.map((e, i) => [e.id, i]));

  // One strand per experiment, facts merged from every source that names it.
  const byId = new Map();
  const touch = (id) => {
    if (!byId.has(id)) {
      byId.set(id, {
        id, name: id, status: '', attemptIndex: 1,
        spawnedBy: null, coveredBy: null, createdAt: null,
      });
    }
    return byId.get(id);
  };

  ws.forEach((w, i) => {
    for (const m of w.materialized_experiments || []) {
      const id = idOf(m);
      if (!id) continue;
      const s = touch(id);
      s.spawnedBy = w.id;
      if (m.name) s.name = m.name;
      if (m.status) s.status = m.status;
      if (m.created_at) s.createdAt = m.created_at;
    }
    for (const id of coveredDelta(w, ws[i - 1])) {
      const s = touch(id);
      // First covering wave wins; a snapshot row can't be un-consolidated.
      if (s.coveredBy == null) s.coveredBy = w.id;
    }
    for (const t of w.corpus?.terminal_experiments || []) {
      const id = idOf(t);
      if (!id || !byId.has(id)) continue;
      const s = byId.get(id);
      if (t.name && s.name === s.id) s.name = t.name;
      if (t.status && !s.status) s.status = t.status;
      if (t.attempt_index) s.attemptIndex = Math.max(s.attemptIndex, t.attempt_index);
    }
  });

  // Live experiment rows are the freshest facts and the only source for
  // experiments no wave has touched yet (user-created, still running, or
  // terminal-but-uncovered — the reflection debt).
  for (const e of experiments || []) {
    const id = idOf(e);
    if (!id) continue;
    const s = touch(id);
    if (e.name) s.name = e.name;
    if (e.status) s.status = e.status;
    if (e.attempt_index) s.attemptIndex = e.attempt_index;
    if (e.created_at && !s.createdAt) s.createdAt = e.created_at;
  }

  const strands = [...byId.values()].map(s => ({
    ...s,
    tone: strandTone(s.status),
    spawnIdx: s.spawnedBy != null ? (waveIdx.get(s.spawnedBy) ?? -1) : -1,
    coverIdx: s.coveredBy != null ? (waveIdx.get(s.coveredBy) ?? -1) : -1,
  }));
  // Stable order: by the segment they occupy, then creation time, then id.
  strands.sort((a, b) =>
    (segStart(a) - segStart(b))
    || String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    || a.id.localeCompare(b.id));
  return { epochs, strands };
}

// Index of the epoch a strand departs from (-1 = enters from the margin
// before wave 1 / mid-stream).
function segStart(s) {
  if (s.spawnIdx >= 0) return s.spawnIdx;
  if (s.coverIdx >= 0) return s.coverIdx - 1;
  return Number.MAX_SAFE_INTEGER; // open-ended strands sort last
}

// Symmetric lane fan: 0 → +1, 1 → -1, 2 → +2, 3 → -2 … (above/below spine).
export function laneOffset(i) {
  const n = Math.floor(i / 2) + 1;
  return i % 2 === 0 ? n : -n;
}

// Group strands by the gap they span so the component can fan each gap
// independently. Key: `${spawnIdx}` for wave-born, `pre${coverIdx}` otherwise;
// open-ended (uncovered / still running) strands group under 'open'.
export function strandGroups(strands, epochCount) {
  const groups = new Map();
  for (const s of strands) {
    let key;
    if (s.coverIdx < 0) key = 'open';
    else if (s.spawnIdx >= 0) key = `g${s.spawnIdx}`;
    else key = `pre${s.coverIdx}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  void epochCount;
  return groups;
}

// The open wave's anatomy, pre-chewed for rendering: lens slots, review-gate
// state, consolidation join. Everything degrades to null/empty when absent.
export function openAnatomy(wave) {
  if (!wave) return null;
  const lenses = (wave.reflection_coverage?.lenses || []).map(l => ({
    id: l.lens_id,
    covered: Boolean(l.covered),
  }));
  const reviewItem = (wave.gate_checklist?.items || []).find(it => it.kind === 'review') || null;
  const lastReview = (wave.reviews || [])[ (wave.reviews || []).length - 1 ] || null;
  const cons = wave.consolidation || {};
  return {
    status: String(wave.status || ''),
    attemptIndex: wave.attempt_index || 1,
    revisionContext: wave.revision_context || '',
    lenses,
    lensesCovered: lenses.filter(l => l.covered).length,
    reviewState: reviewItem?.status || (lastReview ? lastReview.verdict : null),
    consolidation: {
      considered: cons.coverage?.considered ?? null,
      total: cons.coverage?.total ?? null,
      advanceStatus: cons.advance?.status || null,
    },
  };
}
