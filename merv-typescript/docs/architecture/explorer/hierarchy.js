/* Responsibility layers are editorial; every visible relationship comes from source. */
function createPluginHierarchy({ data, select }) {
  const map = document.getElementById('hierarchy-map');
  const stack = document.getElementById('hierarchy-stack');
  const boundaries = document.getElementById('hierarchy-boundaries');
  const wires = document.getElementById('hierarchy-edges');
  const status = document.getElementById('hierarchy-status');
  const checks = document.getElementById('hierarchy-checks');
  const nodes = new Map(data.nodes.map((node) => [node.id, node]));
  const cards = new Map();
  let selected = null,
    hovered = null,
    frame = 0;
  const make = (tag, className, text) => {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  function card(id) {
    const node = nodes.get(id);
    const el = make('button', 'hierarchy-node', node.label);
    el.type = 'button';
    el.dataset.node = id;
    el.title = `${node.plugin} — ${node.purpose}`;
    el.setAttribute('aria-pressed', 'false');
    cards.set(id, el);
    return el;
  }
  const root = make('section', 'hierarchy-root');
  root.append(
    make('span', 'eyebrow', 'Composition · not a plugin'),
    make('h3', '', data.hierarchy.root.label),
    make('p', '', data.hierarchy.root.purpose),
  );
  stack.append(root);
  [...data.hierarchy.layers].reverse().forEach((layer) => {
    const level = data.hierarchy.layers.indexOf(layer);
    const section = make('section', 'hierarchy-layer');
    section.dataset.level = level;
    section.append(make('h3', '', `L${level} · ${layer.label}`), make('p', '', layer.purpose));
    const list = make('div', 'hierarchy-members');
    layer.members.forEach((id) => list.append(card(id)));
    section.append(list);
    stack.append(section);
  });
  const intro = make('div', 'hierarchy-side-intro');
  intro.append(
    make('span', 'eyebrow', 'Beside the stack'),
    make(
      'p',
      '',
      'Adapters expose or connect capabilities. Their vertical position here does not imply a dependency layer.',
    ),
  );
  boundaries.append(intro);
  for (const boundary of data.hierarchy.boundaries) {
    const section = make('section', 'hierarchy-boundary');
    section.append(
      make('h3', '', `${boundary.label} · ${boundary.members.length}`),
      make('p', '', boundary.purpose),
    );
    const list = make('div', 'hierarchy-members');
    boundary.members.forEach((id) => list.append(card(id)));
    section.append(list);
    boundaries.append(section);
  }
  const describe = (edges) =>
    edges
      .map(
        (edge) =>
          `${nodes.get(edge.from).label} → ${nodes.get(edge.to).label}${edge.optional ? ' (optional)' : ''}`,
      )
      .join('; ');
  checks.append(
    make('h3', '', 'Check the hierarchy against the implementation'),
    make(
      'p',
      '',
      `${data.hierarchy.upward.length} declared dependencies point from a lower core layer to a higher one. ${data.hierarchy.peers.length} connect peers within a layer${data.hierarchy.peers.length ? ': ' + describe(data.hierarchy.peers) : ''}. This checks Cordis declarations, not every import, callback or database access.`,
    ),
  );
  if (data.hierarchy.upward.length)
    checks.append(make('p', 'hierarchy-warning', describe(data.hierarchy.upward)));
  checks.append(
    make('h3', '', 'The architectural decisions still to make'),
    make(
      'p',
      '',
      'Sandboxes currently combines an upstream client with optional session, evidence and API integration. That is a candidate boundary to separate. Code Research and Reviews currently collaborate within L4. We should settle those contracts before enforcing a strict lower-layer-only rule.',
    ),
    make(
      'p',
      '',
      'This view changes the explanation and layout. It does not move code or claim that the proposed boundaries are enforced.',
    ),
  );
  const svg = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, String(value)));
    return el;
  };
  function draw() {
    const id = hovered ?? selected;
    const node = nodes.get(id);
    const outgoing = new Set([...(node?.requires ?? []), ...(node?.optional ?? [])]);
    const incoming = new Set(data.edges.filter((edge) => edge.to === id).map((edge) => edge.from));
    for (const [key, el] of cards) {
      const relation =
        key === id ? 'self' : outgoing.has(key) ? 'out' : incoming.has(key) ? 'in' : '';
      if (relation) el.dataset.relation = relation;
      else delete el.dataset.relation;
      el.setAttribute('aria-pressed', String(key === selected));
    }
    status.textContent = node
      ? `${node.label}: ${outgoing.size} dependencies · ${incoming.size} consumers. Click to pin; Escape or Clear selection hides the lines.`
      : `${cards.size} plugins placed once. Lines stay hidden until you hover, focus or select a plugin.`;
    wires.replaceChildren();
    if (!node || !map.clientWidth) return;
    const base = map.getBoundingClientRect();
    wires.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
    const defs = svg('defs', {});
    for (const [kind, color] of [
      ['out', '#8a4f30'],
      ['in', '#4e6d70'],
    ]) {
      const marker = svg('marker', {
        id: `hierarchy-arrow-${kind}`,
        viewBox: '0 0 10 10',
        refX: 9,
        refY: 5,
        markerWidth: 7,
        markerHeight: 7,
        orient: 'auto',
        markerUnits: 'userSpaceOnUse',
      });
      marker.append(
        svg('path', { d: 'M 1 1 L 9 5 L 1 9', fill: 'none', stroke: color, 'stroke-width': 1.6 }),
      );
      defs.append(marker);
    }
    wires.append(defs);
    for (const edge of data.edges.filter((edge) => edge.from === id || edge.to === id)) {
      const from = cards.get(edge.from),
        to = cards.get(edge.to);
      if (!from || !to) continue;
      const a = from.getBoundingClientRect(),
        b = to.getBoundingClientRect();
      const side = Math.abs(a.top - b.top) < 35;
      const direction = b.top >= a.top ? 1 : -1;
      const ax = (side ? a.right : a.left + a.width / 2) - base.left;
      const ay = (side ? a.top + a.height / 2 : direction > 0 ? a.bottom : a.top) - base.top;
      const bx = (side ? b.left : b.left + b.width / 2) - base.left;
      const by = (side ? b.top + b.height / 2 : direction > 0 ? b.top : b.bottom) - base.top;
      const kind = edge.from === id ? 'out' : 'in';
      const d = side
        ? `M ${ax} ${ay} C ${ax + 24} ${ay - 35} ${bx - 24} ${by - 35} ${bx} ${by}`
        : `M ${ax} ${ay} C ${ax} ${(ay + by) / 2} ${bx} ${(ay + by) / 2} ${bx} ${by}`;
      const path = svg('path', {
        d,
        class: `hierarchy-edge ${kind}`,
        'marker-end': `url(#hierarchy-arrow-${kind})`,
      });
      path.dataset.from = edge.from;
      path.dataset.to = edge.to;
      if (edge.optional) path.setAttribute('stroke-dasharray', '6 5');
      const title = svg('title', {});
      title.textContent = `${nodes.get(edge.from).label} ${edge.optional ? 'optionally uses' : 'requires'} ${nodes.get(edge.to).label}`;
      path.append(title);
      wires.append(path);
    }
  }
  map.addEventListener('click', (event) => {
    const el = event.target.closest('.hierarchy-node');
    if (el) select(el.dataset.node);
  });
  for (const event of ['pointerover', 'focusin'])
    map.addEventListener(event, (e) => {
      const el = e.target.closest('.hierarchy-node');
      if (el) {
        hovered = el.dataset.node;
        draw();
      }
    });
  for (const event of ['pointerout', 'focusout'])
    map.addEventListener(event, (e) => {
      const el = e.target.closest('.hierarchy-node');
      if (el && !el.contains(e.relatedTarget)) {
        hovered = null;
        draw();
      }
    });
  document.getElementById('hierarchy-clear').addEventListener('click', () => select(null));
  new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  }).observe(map);
  draw();
  return {
    setSelected(id) {
      selected = id;
      hovered = null;
      draw();
    },
  };
}
