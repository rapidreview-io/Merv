import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useProjectStore, selectClaims, selectExperiments, selectSandboxes } from '../store/useProjectStore';
import { classifyExperiment } from '../utils/evidence';
import { ENTITY_ID_RE, entityPrefix, resolveEntity } from '../utils/entityResolve';
import { expName, TERMINAL_STATUSES } from '../utils/experiment';
import { sizeLabel } from '../utils/fleet';
import { clip, fmtStamp, roleWord } from '../utils/format';
import { extractPaperCitations } from '../utils/paperCitations';
import { computeLayout, nowX as clampNowX } from './mapLayout';

/**
 * useMapModel — the Experiment Map's whole read model.
 *
 * Assembles cards (one per experiment), the world layout, satellite/panel
 * objects, and the inverse citation index from the home snapshot plus three
 * lazy sources: plan/report texts (per-artifact, concurrency-capped),
 * one compute-cost read. Returns progressively — cards render immediately off
 * the snapshot; text-derived refs and compute strings fill in as fetches land.
 */

// ── module caches (survive re-renders, re-mounts, and project revisits) ────

// Artifact text keyed by artifact id — resubmission mints a new id, so stale
// text is superseded rather than refetched forever.
const textCache = new Map();
const textQueued = new Set();
const textJobs = [];
let textInFlight = 0;
const TEXT_CONCURRENCY = 4;
const textListeners = new Set();

const textKey = (res) => res.id;

function pumpTexts() {
  while (textInFlight < TEXT_CONCURRENCY && textJobs.length) {
    const { pid, rid, key } = textJobs.shift();
    textInFlight += 1;
    api.getArtifactContent(pid, rid)
      .then((d) => textCache.set(key, typeof d?.content === 'string' ? d.content : ''))
      .catch(() => textCache.set(key, ''))
      .finally(() => {
        textInFlight -= 1;
        textQueued.delete(key);
        textListeners.forEach((fn) => fn());
        pumpTexts();
      });
  }
}

function enqueueText(pid, res) {
  const key = textKey(res);
  if (textCache.has(key) || textQueued.has(key)) return;
  textQueued.add(key);
  textJobs.push({ pid, rid: res.id, key });
  pumpTexts();
}

// One spend promise per project: StrictMode's doubled mount and any
// re-render reuse the same promise instead of double-fetching. Single slot —
// switching projects evicts, so returning to a project refetches fresh.
const projFetch = { pid: null, spend: null };
function projectFetches(pid) {
  if (projFetch.pid !== pid) {
    projFetch.pid = pid;
    projFetch.spend = api.getComputeCost(pid).catch(() => null);
  }
  return projFetch;
}

// ── per-experiment derivations ─────────────────────────────────────────────

// The experiment's plan/report artifact: current attempt first (how
// ExperimentDetail picks them), else the newest prior attempt's submission.
function roleArtifact(e, role) {
  const cur = (e.current_attempt_artifacts || []).find((r) => r.role === role);
  if (cur) return cur;
  let best = null;
  for (const r of e.artifacts || []) {
    if (r.role !== role) continue;
    if (!best || (r.attempt_index ?? 0) > (best.attempt_index ?? 0)) best = r;
  }
  return best;
}

// Satellite label: ≤ 19 kept chars — sized so two max-width chips always
// share one row under the card (2×(20×6.2+34)+6 ≤ SAT_ROW_W). The word-
// boundary cut only applies when the cap lands mid-word; a cap that already
// ends on a boundary keeps the whole head ("Switch Transformers…").
const SAT_LABEL_MAX = 19;
function satTrunc(s) {
  const t = (s || '').trim();
  if (t.length <= SAT_LABEL_MAX) return t;
  const head = t.slice(0, SAT_LABEL_MAX);
  const midWord = /\w/.test(t[SAT_LABEL_MAX]);
  const cut = midWord && head.includes(' ') ? head.slice(0, head.lastIndexOf(' ')) : head;
  return `${cut.replace(/[\s,;:.]+$/, '')}…`;
}

// Newest review carrying a synopsis (experiment_reviewer/human preferred),
// else the experiment's own intent line.
function pickTldr(e) {
  const withSynopsis = (e.reviews || []).filter(
    (r) => r && typeof r.synopsis === 'string' && r.synopsis.trim(),
  );
  if (withSynopsis.length) {
    const preferred = withSynopsis.filter((r) => r.role === 'experiment_reviewer' || r.role === 'human');
    const pool = preferred.length ? preferred : withSynopsis;
    const latest = pool.slice().sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '')).pop();
    return { tldrKind: 'review', tldr: latest.synopsis.trim() };
  }
  return { tldrKind: 'plan', tldr: (e.intent || '').trim() };
}

const VERDICT = {
  pass: { result: 'passed', tone: 'supports' },
  fail: { result: 'failed', tone: 'refutes' },
  needs_changes: { result: 'needs changes', tone: 'qualifies' },
};

function gatesFor(e) {
  const rows = (e.reviews || [])
    .slice()
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    .map((r) => {
      const v = VERDICT[r.verdict] || { result: r.verdict || 'pending', tone: 'qualifies' };
      return { label: roleWord(r.role), result: v.result, tone: v.tone };
    });
  const gc = e.gate_checklist;
  const unsatisfied = (gc?.items || []).some((i) => !i.satisfied);
  if (!TERMINAL_STATUSES.includes(e.status) && unsatisfied) {
    rows.push({
      label: String(gc.transition || e.status || '').replace(/_/g, ' '),
      result: 'pending',
      tone: 'running',
    });
  }
  return rows;
}

// '36h' / '2.5h': integer from 10h up, one decimal below.
const fmtMapHours = (h) => `${h >= 10 ? Math.round(h) : Number(h.toFixed(1))}h`;

// Unparseable-date fallback, frozen per experiment id: startMs feeds the
// layout memo key, so it must never wander between renders.
const startFallback = new Map();
function stableStartMs(e) {
  const t = Date.parse(e.created_at || '') || Date.parse(e.updated_at || '');
  if (t) return t;
  if (!startFallback.has(e.id)) startFallback.set(e.id, Date.now());
  return startFallback.get(e.id);
}

// ── the hook ───────────────────────────────────────────────────────────────

export function useMapModel(viewW) {
  const projectId = useProjectStore((s) => s.projectId);
  const home = useProjectStore((s) => s.home);
  const experiments = useProjectStore(selectExperiments);
  const claims = useProjectStore(selectClaims);
  const sandboxes = useProjectStore(selectSandboxes);

  const [spend, setSpend] = useState(null);
  const [textTick, setTextTick] = useState(0);

  // Re-render when queued plan/report texts land in the module cache. The
  // bumps are trailing-debounced: a burst of completions (4-deep fetch queue)
  // costs one model recompute, not one per artifact.
  useEffect(() => {
    let timer = null;
    const bump = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; setTextTick((t) => t + 1); }, 50);
    };
    textListeners.add(bump);
    return () => {
      textListeners.delete(bump);
      if (timer) clearTimeout(timer);
    };
  }, []);

  // The project-level compute read, once per project (StrictMode-safe via the
  // shared promise). Errors resolve to null and compute labels stay empty.
  useEffect(() => {
    if (!projectId) return undefined;
    let alive = true;
    setSpend(null);
    const f = projectFetches(projectId);
    f.spend.then((d) => { if (alive) setSpend(d); });
    return () => { alive = false; };
  }, [projectId]);

  // Queue plan/report content fetches (capped, deduped by artifact id).
  useEffect(() => {
    if (!projectId) return;
    for (const e of experiments) {
      for (const role of ['plan', 'report']) {
        const r = roleArtifact(e, role);
        if (r) enqueueText(projectId, r);
      }
    }
  }, [projectId, experiments]);

  // Cards + papers + citedBy in one pass (the text scan feeds all three).
  const model = useMemo(() => {
    const spendByExp = new Map();
    for (const en of spend?.by_experiment || []) {
      if (en.experiment_id) spendByExp.set(en.experiment_id, en);
    }
    const sbxByExp = new Map();
    for (const s of sandboxes) {
      const ids = new Set(
        [s.experiment_id, ...(Array.isArray(s.active_experiment_ids) ? s.active_experiment_ids : [])].filter(Boolean),
      );
      for (const id of ids) {
        if (!sbxByExp.has(id)) sbxByExp.set(id, []);
        sbxByExp.get(id).push(s);
      }
    }
    const claimById = new Map();
    for (const c of claims) if (c?.id) claimById.set(c.id, c);
    for (const e of experiments) {
      for (const c of e.tested_claims || []) if (c?.id && !claimById.has(c.id)) claimById.set(c.id, c);
    }

    const papers = {};
    const citedBy = {};
    const cards = [];

    // Pre-pass: portable paper citations come from the plan, where they encode
    // design provenance. Report text still contributes ordinary entity refs.
    // Harvest all plans first so a titled citation names the paper everywhere.
    const paperCitationsByExp = new Map();
    const textByExp = new Map();
    for (const e of experiments) {
      const planArtifact = roleArtifact(e, 'plan');
      const reportArtifact = roleArtifact(e, 'report');
      const planText = planArtifact ? textCache.get(textKey(planArtifact)) || '' : '';
      const reportText = reportArtifact ? textCache.get(textKey(reportArtifact)) || '' : '';
      const text = [planText, reportText].join('\n');
      textByExp.set(e.id, text);
      const citations = extractPaperCitations(planText);
      paperCitationsByExp.set(e.id, citations);
      for (const citation of citations) {
        const existing = papers[citation.key];
        if (!existing || (!existing.citation.title && citation.title)) {
          const host = new URL(citation.url).hostname.replace(/^www\./, '');
          papers[citation.key] = {
            title: citation.title || citation.sourceLabel,
            sub: citation.title ? `${citation.sourceLabel} · ${host}` : host,
            url: citation.url,
            detail: null,
            sourceLabel: citation.sourceLabel,
            citation,
          };
        }
      }
    }

    for (const e of experiments) {
      const outcome = classifyExperiment(e);
      const startMs = stableStartMs(e);
      const terminal = TERMINAL_STATUSES.includes(e.status);
      const endMs = terminal ? Date.parse(e.updated_at || '') || null : null;

      // Text scan over plan + report ('' until fetched — refs fill in later).
      const text = textByExp.get(e.id) || '';

      const refs = [];
      const seenRef = new Set();
      const pushRef = (ref) => {
        const k = `${ref.type}:${ref.id}`;
        if (!seenRef.has(k)) { seenRef.add(k); refs.push(ref); }
      };

      const textClaimIds = [];
      for (const id of new Set(text.match(ENTITY_ID_RE) || [])) {
        if (id === e.id) continue;
        const kind = entityPrefix(id);
        if (kind !== 'exp' && kind !== 'claim' && kind !== 'art') continue;
        const ent = resolveEntity(id, home);
        if (!ent?.navigable) continue; // unknown / unresolvable id — drop
        if (kind === 'claim') { textClaimIds.push(id); continue; } // joins the claim union below
        pushRef({
          type: kind,
          id,
          label: ent.label,
          sub: kind === 'exp' ? clip(ent.detail?.intent, 64) : ent.detail?.role || 'artifact',
        });
      }

      const cardPaperIds = [];
      for (const citation of paperCitationsByExp.get(e.id) || []) {
        const pid = citation.key;
        const paper = papers[pid];
        if (!cardPaperIds.includes(pid)) cardPaperIds.push(pid);
        pushRef({
          type: 'paper',
          id: pid,
          label: clip(paper?.title, 44) || citation.sourceLabel,
          sub: citation.sourceLabel,
        });
      }

      // Claims: tested_claims seed the map before any text arrives; claim ids
      // found in text join the union.
      const claimIds = [];
      for (const c of e.tested_claims || []) if (c?.id && !claimIds.includes(c.id)) claimIds.push(c.id);
      for (const id of textClaimIds) if (!claimIds.includes(id)) claimIds.push(id);
      for (const id of claimIds) {
        const c = claimById.get(id);
        pushRef({
          type: 'claim',
          id,
          label: clip(c?.statement, 44) || 'claim',
          sub: ['claim', c?.status].filter(Boolean).join(' · '),
        });
      }

      const sbxRows = sbxByExp.get(e.id) || [];
      const sbxIds = [];
      // Sandbox satellites read as hardware, not uids: one chip per distinct
      // SKU ('3× 8×H100'), falling back to a short uid when the SKU is unknown.
      // The chip opens its group's first sandbox; the panel meta counts them all.
      const sbxGroups = new Map();
      for (const s of sbxRows) {
        const id = s.sandbox_uid || s.sandbox_id;
        if (!id || sbxIds.includes(id)) continue;
        sbxIds.push(id);
        const hw = s.gpu || s.instance_type || null;
        const k = hw || id;
        if (!sbxGroups.has(k)) sbxGroups.set(k, { id, hw, n: 0 });
        sbxGroups.get(k).n += 1;
      }

      const sats = [
        ...cardPaperIds.map((pid) => ({
          type: 'paper',
          id: pid,
          label: satTrunc(papers[pid]?.title || papers[pid]?.sourceLabel || pid),
        })),
        ...claimIds.map((cid) => ({ type: 'claim', id: cid, label: satTrunc(claimById.get(cid)?.statement) || 'claim' })),
        ...[...sbxGroups.values()].map((g) => ({
          type: 'sbx',
          id: g.id,
          label: g.hw ? (g.n > 1 ? `${g.n}× ${g.hw}` : g.hw) : g.id.slice(0, 8),
        })),
      ];

      const hours = spendByExp.get(e.id)?.hours;
      const sku = sbxRows.map((s) => s.gpu || s.instance_type).find(Boolean) || null;
      const computeStr = Number.isFinite(hours) && hours > 0
        ? (sku ? `${fmtMapHours(hours)} × ${sku}` : fmtMapHours(hours))
        : null;

      cards.push({
        id: e.id,
        title: expName(e),
        status: outcome === 'inflight' ? 'running' : outcome,
        startMs,
        endMs,
        when: fmtStamp(startMs) + (endMs ? ` → ${fmtStamp(endMs)}` : ' → …'),
        ...pickTldr(e),
        sats,
        refs,
        metrics: [],
        gates: gatesFor(e),
        artifacts: (e.storage_objects || []).length,
        agent: roleArtifact(e, 'report')?.created_by || roleArtifact(e, 'plan')?.created_by || null,
        computeStr,
        sbxIds,
      });
    }

    for (const c of cards) {
      for (const r of c.refs) {
        if (r.type !== 'exp') continue;
        (citedBy[r.id] = citedBy[r.id] || []).push(c.id);
      }
    }

    return { cards, papers, citedBy };
  }, [home, experiments, claims, sandboxes, spend, textTick]);

  // Heavy packing keyed on ids + start times + a coarse pane-width bucket:
  // a poll tick that changes card contents (status, tldr, metrics) must not
  // re-pack the world, and neither should every pixel of a window drag.
  const wBucket = viewW ? Math.round(viewW / 96) * 96 : 0;
  const layoutKey = model.cards.map((c) => `${c.id}:${c.startMs}`).join('|');
  const world = useMemo(
    () => computeLayout(
      model.cards.map((c) => ({ id: c.id, startMs: c.startMs })),
      Date.now(),
      // Fill the pane at fit: fitViewportFor pads 280+60 world px + 80 screen.
      wBucket ? Math.max(0, wBucket - 420) : null,
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutKey, wBucket],
  );
  // The now-clamp is cheap — keep it current without touching the memo above.
  const nx = clampNowX(world.xFor, world.pos, Date.now());
  const layout = useMemo(() => ({ ...world, nowX: nx }), [world, nx]);

  const objects = useMemo(() => {
    const claimObjs = {};
    const addClaim = (c) => {
      if (!c?.id || claimObjs[c.id]) return;
      claimObjs[c.id] = {
        title: c.statement || c.id,
        sub: ['claim', c.status, c.confidence ? `${c.confidence} confidence` : null].filter(Boolean).join(' · '),
        detail: c.statement || null,
      };
    };
    claims.forEach(addClaim);
    for (const e of experiments) (e.tested_claims || []).forEach(addClaim);
    const sbxObjs = {};
    for (const s of sandboxes) {
      const id = s.sandbox_uid || s.sandbox_id;
      if (!id || sbxObjs[id]) continue;
      const hw = s.gpu || s.instance_type || null;
      // Short uid in the title — prod uids are 32-hex; the head row shows the full id.
      const shortId = id.length > 12 ? id.slice(0, 8) : id;
      sbxObjs[id] = {
        title: hw ? `${shortId} · ${hw}` : shortId,
        sub: [s.status, s.region].filter(Boolean).join(' · '),
        // Hardware line the fleet table renders — the fields we actually have.
        detail: [s.gpu, sizeLabel(s)].filter(Boolean).join(' · ') || null,
      };
    }
    return { claims: claimObjs, papers: model.papers, sandboxes: sbxObjs };
  }, [claims, experiments, sandboxes, model.papers]);

  return useMemo(
    () => ({ ready: !!home, cards: model.cards, layout, objects, citedBy: model.citedBy }),
    [home, model, layout, objects],
  );
}
