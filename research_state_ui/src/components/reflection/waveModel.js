/**
 * waveModel — shared reflection-wave role-resolution policy + belief-state
 * logic, consumed by both the desktop ProjectReflectionPanel and the mobile
 * MobileReflectionScreen so the two surfaces never drift. Pure helpers, no JSX.
 */

export const TERMINAL_WAVE = new Set(['published', 'abandoned']);

// Roles with their own dedicated section above; everything else a wave
// submits falls through to the quiet "change_spec / other docs" disclosures.
const PRIMARY_ROLES = new Set(['graph', 'project_graph', 'reflection_lens_doc', 'reflection_doc']);

// Nice labels for known secondary doc roles; anything else is humanized so a
// new backend role never goes unrendered as the reflection model evolves.
const DOC_ROLE_META = {
  change_spec: { label: 'Change spec — belief-state update', order: 0 },
  proposals: { label: "What's next — proposals", order: 1 },
};

function humanizeRole(role) {
  return role.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Resolve each roster lens to the reflection artifact submitted for the wave's
// current attempt. Artifacts carry an explicit `lens_id` (submission requires
// it for role reflection_lens_doc), so the match is direct — no filename
// heuristics. An artifact id pins exact bytes, so no version pinning either.
export function reflectionsByLens(wave) {
  const byLens = {};
  for (const r of wave?.current_attempt_artifacts || []) {
    if (r.role === 'reflection_lens_doc' && r.lens_id) byLens[r.lens_id] = r;
  }
  const map = {};
  for (const lens of wave?.reflection_coverage?.lenses || []) {
    const res = byLens[lens.lens_id] || null;
    map[lens.lens_id] = {
      covered: Boolean(lens.covered),
      artifactId: res?.id || null,
      path: res?.path || lens.path || null,
    };
  }
  return map;
}

// The secondary docs (everything that isn't graph / lens doc / reflection_doc):
// today just the change_spec, but derived from the artifacts so new roles render
// automatically. First artifact per role wins.
export function secondaryDocs(artifacts) {
  const seen = new Set();
  const docs = [];
  for (const r of artifacts) {
    const role = r.role;
    if (!role || PRIMARY_ROLES.has(role) || seen.has(role)) continue;
    seen.add(role);
    const meta = DOC_ROLE_META[role] || {};
    docs.push({ role, res: r, label: meta.label || humanizeRole(role), order: meta.order ?? 100 });
  }
  return docs.sort((a, b) => a.order - b.order || a.role.localeCompare(b.role));
}

export function resolveReflectionDoc(artifacts) {
  return artifacts.find(r => r.role === 'reflection_doc') || null;
}

// Wave lifecycle order, for "has this stage been reached" checks.
const STAGE_RANK = {
  reflecting: 0, synthesizing: 1, reflection_review: 2,
  consolidating: 3, published: 4, abandoned: 4,
};

/**
 * buildWaveFigure — the wave's PROCESS graph, derived client-side from the
 * wave payload the same way the experiment figure is derived server-side:
 * the attempt spine with its revision loops, the lens fan-in, the
 * consolidated synthesis, the review verdict, consolidation, publication.
 * Pure data in the figure vocabulary ({nodes, edges} for layoutFigure);
 * same JSON in → same graph out, so polling never reshuffles the canvas.
 */
export function buildWaveFigure(wave) {
  if (!wave) return { nodes: [], edges: [] };
  const status = String(wave.status || '');
  const stage = STAGE_RANK[status] ?? 0;
  const open = !TERMINAL_WAVE.has(status);
  const attempts = wave.attempt_index || 1;
  const nodes = [];
  const edges = [];
  let prev = null;
  const link = (id, type = 'flow') => {
    if (prev) edges.push({ id: `${prev}>${id}`, from: prev, to: id, type });
    prev = id;
  };

  // Superseded attempts, each rejected by a review. Only the latest
  // rejection's reason survives in revision_context.
  for (let i = 1; i < attempts; i++) {
    nodes.push({ id: `a${i}`, type: 'attempt', label: `attempt ${i}`, status: 'superseded' });
    link(`a${i}`);
    nodes.push({
      id: `rv${i}`, type: 'review', label: 'reflection review', status: 'needs_changes',
      sublabel: i === attempts - 1 ? (wave.revision_context || '') : '',
    });
    link(`rv${i}`);
  }

  nodes.push({
    id: `a${attempts}`, type: 'attempt', label: `attempt ${attempts}`,
    status: status === 'abandoned' ? 'abandoned' : (open ? 'active' : 'done'),
  });
  link(`a${attempts}`, attempts > 1 ? 'revised_to' : 'flow');

  const lenses = wave.reflection_coverage?.lenses || [];
  if (lenses.length) {
    const covered = lenses.filter(l => l.covered).length;
    nodes.push({
      id: 'lenses', type: 'artifact_group', label: 'lens reflections',
      sublabel: `${covered} of ${lenses.length} lenses`,
      status: covered >= lenses.length ? 'done' : 'active',
    });
    link('lenses');
  }

  const doc = resolveReflectionDoc(wave.current_attempt_artifacts || []);
  if (doc || stage >= STAGE_RANK.reflection_review) {
    nodes.push({
      id: 'synthesis', type: 'submission', label: 'consolidated reflection',
      sublabel: doc?.path || '', status: stage <= STAGE_RANK.synthesizing ? 'open' : 'done',
    });
    link('synthesis');
  }

  if (stage >= STAGE_RANK.reflection_review && status !== 'abandoned') {
    nodes.push({
      id: 'review', type: 'review', label: 'reflection review',
      status: status === 'reflection_review' ? 'open' : 'pass',
      sublabel: status === 'reflection_review' ? 'awaiting reviewer' : '',
    });
    link('review');
  }

  if (stage >= STAGE_RANK.consolidating && status !== 'abandoned') {
    nodes.push({
      id: 'consolidation', type: 'consolidation', label: 'code consolidation',
      status: status === 'consolidating' ? 'active' : 'done',
    });
    link('consolidation');
  }

  if (status === 'published') {
    nodes.push({
      id: 'published', type: 'conclusion', label: 'published',
      sublabel: wave.published_at ? String(wave.published_at).slice(0, 10) : '', status: 'done',
    });
    link('published');
  } else if (status === 'abandoned') {
    nodes.push({ id: 'end', type: 'conclusion', label: 'abandoned', status: 'abandoned' });
    link('end');
  }

  return { nodes, edges };
}
