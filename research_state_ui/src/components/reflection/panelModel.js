/**
 * panelModel — the read model behind the project graph's sidebar
 * (WaveFlowPanel): what to say about a selected experiment, wave, stack,
 * origin, or the ghost "next" wave, derived from the braid plus the raw
 * experiment rows and wave payloads. Pure data, no JSX — same discipline as
 * braidModel.js / waveModel.js so the mobile surface can reuse it and the
 * derivations can be unit-tested without a DOM.
 */

const TERMINAL_TONES = new Set(['done', 'failed', 'abandoned']);

export const ROLE_WORD = {
  design_reviewer: 'design review',
  experiment_reviewer: 'experiment review',
  task_reviewer: 'task review',
  reflection_reviewer: 'reflection review',
  consolidation_reviewer: 'consolidation review',
  human: 'human review',
};

// Verdict vocabulary shared by every review row the sidebar draws. `word` is
// the past-tense event ("sent back", not "needs changes") because the panel
// reads as a history, not a state.
export const VERDICT = {
  pass: { word: 'passed', tone: 'supports', glyph: '✓' },
  needs_changes: { word: 'sent back', tone: 'qualifies', glyph: '↩' },
  fail: { word: 'failed', tone: 'refutes', glyph: '✗' },
};

export function roleWord(role) {
  if (ROLE_WORD[role]) return ROLE_WORD[role];
  const r = String(role || 'review').replace(/_reviewer$/, '').replace(/_/g, ' ');
  return /review$/.test(r) ? r : `${r} review`;
}

export function statusWord(s) {
  return String(s || '').replace(/_/g, ' ');
}

// Second-resolution timestamps tie when two reviews land within one second
// (a send-back and its fix); the insertion sequence breaks the tie.
const byCreated = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''))
  || ((Number(a.created_seq) || 0) - (Number(b.created_seq) || 0));

/** Newest review, optionally restricted to a set of roles. */
export function latestReview(reviews, roles = null) {
  const pool = (reviews || []).filter(r => r && (!roles || roles.includes(r.role)));
  return pool.slice().sort(byCreated).pop() || null;
}

/** Every review as a display row, oldest first. */
export function reviewHistory(reviews) {
  return (reviews || []).filter(Boolean).slice().sort(byCreated).map((r, i) => {
    const v = VERDICT[r.verdict] || { word: statusWord(r.verdict) || 'pending', tone: 'qualifies', glyph: '·' };
    return {
      id: r.id || `${r.role}:${r.created_at || i}`,
      role: r.role,
      roleWord: roleWord(r.role),
      verdict: r.verdict,
      verdictWord: v.word,
      tone: v.tone,
      glyph: v.glyph,
      returnTo: r.return_to ? statusWord(r.return_to) : '',
      synopsis: String(r.synopsis || '').trim(),
      when: r.created_at || null,
    };
  });
}

/**
 * The one thing to say about where an experiment stands: for finished work
 * its outcome (the reviewer's read of the result), for live work its latest
 * review. Null when there is nothing to say yet.
 */
export function outcomeOf(strand, row) {
  const reviews = row?.reviews || [];
  const isTask = strand?.kind === 'task';
  const expRv = latestReview(
    reviews,
    isTask ? ['task_reviewer', 'human'] : ['experiment_reviewer', 'human'],
  );
  const tone = strand?.tone;
  if (tone === 'done') {
    return {
      eyebrow: 'Outcome',
      line: isTask ? 'accepted after task review' : 'passed experiment review',
      tone: 'supports', glyph: '✓',
      text: String(expRv?.synopsis || row?.outcome || row?.conclusion || '').trim(),
      when: expRv?.created_at || row?.updated_at || null,
    };
  }
  if (tone === 'failed') {
    const byReviewer = expRv?.verdict === 'fail' || row?.failed_by === 'reviewer';
    return {
      eyebrow: 'Outcome',
      line: isTask
        ? (byReviewer ? 'ended by task review' : 'ended by its owner')
        : (expRv?.verdict === 'fail' ? 'failed experiment review' : 'marked failed'),
      tone: 'refutes', glyph: '✗',
      text: String(expRv?.synopsis || (isTask ? row?.outcome : '') || '').trim(),
      when: expRv?.created_at || row?.updated_at || null,
    };
  }
  if (tone === 'abandoned') {
    return { eyebrow: 'Outcome', line: 'abandoned', tone: 'faint', glyph: '·', text: '', when: row?.updated_at || null };
  }
  const rv = latestReview(reviews);
  if (!rv) return null;
  const v = VERDICT[rv.verdict] || { word: statusWord(rv.verdict), tone: 'qualifies', glyph: '·' };
  return {
    eyebrow: 'Latest review',
    line: `${roleWord(rv.role)} · ${v.word}${rv.return_to ? ` to ${statusWord(rv.return_to)}` : ''}`,
    tone: v.tone, glyph: v.glyph,
    text: String(rv.synopsis || '').trim(),
    when: rv.created_at || null,
  };
}

// Pre-wave column membership, mirroring buildFlowModel's colOf === -1.
export function makeColOf(epochs) {
  const openIdx = epochs.findIndex(e => e.isOpen);
  const frontierCol = openIdx >= 0 ? openIdx - 1 : epochs.length - 1;
  return (s) => (s.spawnIdx >= 0 ? s.spawnIdx
    : s.coverIdx >= 0 ? s.coverIdx - 1 : frontierCol);
}

export function seedStrands({ epochs, strands }) {
  const colOf = makeColOf(epochs);
  return strands.filter(s => colOf(s) === -1);
}

/** Whether the canvas draws a ghost "next" pill: nothing open, work uncovered. */
export function hasGhost({ epochs, strands }) {
  return !epochs.some(e => e.isOpen) && strands.some(s => s.coverIdx < 0);
}

/**
 * Where a strand comes from and where it goes, as the two lineage rows the
 * sidebar draws. `from` is a wave, the project origin (a pre-wave seed), or
 * nothing (added by hand mid-stream); `to` is the wave that consolidated it,
 * the open wave it will feed, the ghost it is waiting on, or nothing.
 */
export function lineageOf(strand, braid) {
  const { epochs } = braid;
  const colOf = makeColOf(epochs);
  const openIdx = epochs.findIndex(e => e.isOpen);
  const finished = TERMINAL_TONES.has(strand.tone);
  let from;
  if (strand.spawnIdx >= 0) from = { kind: 'wave', epoch: epochs[strand.spawnIdx], word: 'proposed by' };
  else if (colOf(strand) === -1) from = { kind: 'origin', word: 'seeded at' };
  else from = { kind: 'none', word: 'added', text: 'by hand, outside a wave' };
  let to;
  if (strand.coverIdx >= 0) {
    to = { kind: 'wave', epoch: epochs[strand.coverIdx], word: 'consolidated by' };
  } else if (openIdx >= 0) {
    to = {
      kind: 'wave', epoch: epochs[openIdx], pending: true,
      word: finished ? 'waiting for' : 'will feed',
      text: finished ? 'finished — not yet consolidated' : 'once it finishes',
    };
  } else if (hasGhost(braid)) {
    to = {
      kind: 'ghost', pending: true,
      word: finished ? 'waiting for' : 'will feed',
      text: finished ? 'the next reflection' : 'the next reflection, once it finishes',
    };
  } else {
    to = { kind: 'none', word: 'consolidated', text: 'not yet' };
  }
  return { from, to };
}

/**
 * The gate checklist as the sidebar shows it: the status it leads to and the
 * items, unsatisfied first so the blockers lead. Lens items are separated
 * out — the wave panel draws those as coverage chips instead of rows.
 */
export function gateSummary(gate) {
  if (!gate || typeof gate !== 'object') return null;
  const items = (gate.items || []).map(it => ({
    id: it.id || it.label,
    label: String(it.label || '').replace(/\.$/, ''),
    satisfied: Boolean(it.satisfied),
    kind: it.kind || '',
  }));
  const rows = items.filter(it => it.kind !== 'reflection_lens');
  rows.sort((a, b) => Number(a.satisfied) - Number(b.satisfied));
  return {
    transition: gate.transition ? statusWord(gate.transition) : '',
    leadsTo: gate.leads_to ? statusWord(gate.leads_to) : '',
    ready: Boolean(gate.ready),
    items: rows,
    missing: rows.filter(it => !it.satisfied).length,
    lensesMissing: items.filter(it => it.kind === 'reflection_lens' && !it.satisfied).length,
  };
}

/** Roster lenses joined with coverage and each covered lens's TLDR. */
export function waveLenses(wave) {
  if (!wave) return [];
  const tldrByLens = {};
  for (const a of wave.current_attempt_artifacts || []) {
    if (a.role === 'reflection_lens_doc' && a.lens_id) tldrByLens[a.lens_id] = String(a.tldr || '').trim();
  }
  const cov = {};
  for (const l of wave.reflection_coverage?.lenses || []) cov[l.lens_id] = l;
  const roster = wave.roster || [];
  const ids = roster.length ? roster.map(r => r.id) : Object.keys(cov);
  return ids.map(id => {
    const r = roster.find(x => x.id === id) || {};
    const c = cov[id] || {};
    return {
      id,
      title: r.title || id,
      charter: r.charter || '',
      core: Boolean(r.core),
      covered: Boolean(c.covered),
      artifactId: c.artifact_id || null,
      tldr: tldrByLens[id] || '',
    };
  });
}

/** The wave's own one-line story: its reflection document's TLDR. */
export function waveStory(wave) {
  const doc = (wave?.current_attempt_artifacts || []).find(a => a.role === 'reflection_doc');
  return String(doc?.tldr || '').trim();
}

/**
 * Consolidation, boiled down: the code proposal's summary, plus which
 * experiments' code was promoted (used as is / adapted). "Reviewed, not
 * used" is the common case and stays implicit — the summary sentence
 * already says so — so a wave that promoted nothing shows the summary alone.
 */
export function consolidationSummary(wave) {
  const cons = wave?.consolidation;
  if (!cons) return null;
  const summary = String(cons.proposal?.summary || '').trim();
  const promoted = (cons.decisions || [])
    .filter(d => d && (d.disposition === 'used_as_is' || d.disposition === 'adapted'))
    .map(d => ({ name: d.experiment_name || d.experiment_id, disposition: statusWord(d.disposition) }));
  if (!summary && !promoted.length) return null;
  return { summary, promoted };
}

/**
 * The reflection debt as a meter: n finished experiments since the last
 * published wave, out of the m that block new experiments, with the nudge
 * mark. Null when the signal carries no threshold.
 */
export function debtMeter(signal) {
  const m = Number(signal?.block_new_terminal_threshold);
  if (!Number.isFinite(m) || m <= 0) return null;
  const n = Math.max(0, Number(signal?.new_terminal_since_publish) || 0);
  const nudge = Number(signal?.nudge_new_terminal_threshold);
  return {
    n, m,
    nudge: Number.isFinite(nudge) && nudge > 0 && nudge < m ? nudge : null,
    blocked: Boolean(signal?.experiment_create_blocked) || n >= m,
    nudged: Number.isFinite(nudge) && n >= nudge,
  };
}

/**
 * Timeline facts for an experiment: when it started, when it ended (finished
 * work) or how long it has been at its current status (live work).
 */
export function expTimeline(strand, row, now = Date.now()) {
  const created = row?.created_at || strand?.createdAt || null;
  const updated = row?.updated_at || null;
  const t0 = created ? Date.parse(created) : NaN;
  const t1 = updated ? Date.parse(updated) : NaN;
  const finished = TERMINAL_TONES.has(strand?.tone);
  return {
    created,
    ended: finished ? updated : null,
    spanMs: finished && Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, t1 - t0) : null,
    sinceMs: !finished && Number.isFinite(t1) ? Math.max(0, now - t1) : null,
    ageMs: Number.isFinite(t0) ? Math.max(0, now - t0) : null,
    endWord: strand?.tone === 'done' ? 'finished' : strand?.tone === 'failed' ? 'failed' : strand?.tone === 'abandoned' ? 'abandoned' : '',
  };
}

/** Intent lookup across every source that names an experiment. */
export function buildIntentIndex(experiments, waves, tasks = []) {
  const idx = new Map();
  for (const e of experiments || []) if (e?.id && e.intent) idx.set(e.id, String(e.intent).trim());
  for (const t of tasks || []) if (t?.id && (t.summary || t.goal)) idx.set(t.id, String(t.summary || t.goal).trim());
  for (const w of waves || []) {
    for (const m of w?.materialized_experiments || []) {
      const id = m?.experiment_id || m?.id;
      if (id && m.intent && !idx.has(id)) idx.set(id, String(m.intent).trim());
    }
    for (const m of w?.materialized_tasks || []) {
      const id = m?.task_id || m?.id;
      if (id && m.goal && !idx.has(id)) idx.set(id, String(m.goal).trim());
    }
    for (const t of w?.corpus?.terminal_experiments || []) {
      if (t?.id && t.intent && !idx.has(t.id)) idx.set(t.id, String(t.intent).trim());
    }
    for (const t of w?.corpus?.terminal_tasks || []) {
      if (t?.id && t.goal && !idx.has(t.id)) idx.set(t.id, String(t.goal).trim());
    }
  }
  return idx;
}
