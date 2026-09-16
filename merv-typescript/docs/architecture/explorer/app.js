(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('architecture-data').textContent);
  const map = document.getElementById('map');
  const groupsHost = document.getElementById('groups');
  const inspector = document.getElementById('inspector');
  const wires = document.getElementById('wires');
  const status = document.getElementById('map-status');
  const announcement = document.getElementById('announcement');
  const detailJump = document.getElementById('detail-jump');
  const nodes = new Map(data.nodes.map((node) => [node.id, node]));
  const groups = new Map(data.groups.map((group) => [group.id, group]));
  const externals = [
    {
      id: 'remote-nisa',
      label: 'Nisa MCP',
      group: 'external',
      purpose:
        'Independent research retrieval and Q&A tools, connected through an optional MCP mount.',
    },
    {
      id: 'remote-sandboxes',
      label: 'Sandboxes MCP',
      group: 'external',
      purpose:
        'Independent sandbox tools, connected through an optional MCP mount. Remote jobs have their own lifecycle.',
    },
  ];
  const remote = new Map(externals.map((node) => [node.id, node]));
  let selected = null;
  let hovered = null;
  let pendingFrame = 0;
  let currentView = 'map';
  const el = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const info = (id) => nodes.get(id) ?? remote.get(id);
  const label = (id) => info(id)?.label ?? id;
  const groupOf = (id) => info(id)?.group;
  const button = (text, target, className = 'detail-link') => {
    const b = el('button', className, text);
    b.type = 'button';
    b.dataset.target = target;
    return b;
  };
  const adapterCount = data.nodes.filter((node) => node.kind !== 'service').length;
  document.getElementById('snapshot').textContent = `Working-tree snapshot · ${data.snapshot}`;
  document.getElementById('inventory').textContent =
    `${data.counts.providers} service plugins · ${adapterCount} small adapters`;

  for (const group of data.groups) {
    const card = el('section', 'group');
    card.dataset.group = group.id;
    const outline = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    outline.classList.add('group-outline');
    outline.setAttribute('viewBox', '0 0 200 160');
    outline.setAttribute('preserveAspectRatio', 'none');
    outline.setAttribute('aria-hidden', 'true');
    for (const [x, y, width, height] of [
      [1.3, 1.1, 197, 157],
      [2.4, 2, 194.8, 155.7],
    ]) {
      const rect = document.createElementNS(outline.namespaceURI, 'rect');
      Object.entries({ x, y, width, height, rx: 2.1 }).forEach(([k, v]) =>
        rect.setAttribute(k, String(v)),
      );
      outline.append(rect);
    }
    card.append(
      outline,
      button(group.label, `group:${group.id}`, 'group-heading'),
      el('span', 'group-caption', group.caption),
    );
    const list = el('div', 'plugin-list');
    const members =
      group.id === 'external'
        ? externals
        : group.members.map((id) => nodes.get(id)).filter(Boolean);
    for (const node of members) {
      const b = button(node.label, node.id, 'plugin');
      b.dataset.node = node.id;
      b.setAttribute('aria-pressed', 'false');
      list.append(b);
    }
    card.append(list);
    if (group.id === 'front')
      card.append(button(`${adapterCount} domain adapters ↗`, 'adapters', 'adapter-badge'));
    groupsHost.append(card);
  }

  function heading(text) {
    inspector.append(el('h3', '', text));
  }
  function links(ids, kind = '') {
    const list = el('div', `detail-list ${kind}`);
    [...new Set(ids)].forEach((id) => list.append(button(label(id), id)));
    inspector.append(list);
    if (!ids.length) inspector.append(el('p', 'empty', 'None.'));
  }
  function relationships(edges) {
    for (const edge of edges) {
      const row = el('div', 'detail-edge');
      row.append(
        button(label(edge.from), edge.from),
        el('span', '', edge.optional ? '⇢ optional' : '→'),
        button(label(edge.to), edge.to),
      );
      inspector.append(row);
    }
  }
  function showDetails(target) {
    inspector.replaceChildren();
    if (!target) {
      inspector.append(
        el('span', 'kicker', 'Field notes'),
        el('h2', '', 'Follow a thread.'),
        el(
          'p',
          '',
          'Hover a plugin to trace its direct relationships. Click it to keep its details open. The rest of the page stays quiet.',
        ),
        el('div', 'note-rule'),
        el(
          'p',
          '',
          '“Requires” points to a dependency. “Used by” shows the plugins that need it. Click any name in this panel to follow the connection.',
        ),
      );
      heading('Start with the shared foundation');
      links(['scope', 'state']);
      heading('Or follow the research');
      links(['experiments', 'knowledge']);
      heading('About this page');
      inspector.append(
        el(
          'p',
          '',
          `${data.counts.plugins} plugin entrypoints and ${data.counts.dependencies} declared dependencies, read from source. The outer map groups service dependencies; selecting a plugin also reveals its adapters.`,
        ),
        el(
          'p',
          '',
          'This is an editable architecture view, not a running-server monitor. A declared dependency does not prove a remote service is available.',
        ),
      );
      return;
    }
    if (target === 'adapters') {
      inspector.append(
        el('span', 'kicker', 'Transport & UI connections'),
        el('h2', '', `${adapterCount} small adapters`),
        el(
          'p',
          '',
          'Each adapter requires its domain owner and one registry. They expose a domain through Tools, API or UI without owning its business logic.',
        ),
      );
      for (const kind of ['tools', 'ui', 'api']) {
        const items = data.nodes.filter((node) => node.kind === kind);
        heading(`${kind === 'tools' ? 'Tool' : kind.toUpperCase()} adapters · ${items.length}`);
        links(items.map((node) => node.id));
      }
      return;
    }
    if (target.startsWith('group:')) {
      const group = groups.get(target.slice(6));
      if (!group) return;
      inspector.append(
        el('span', 'kicker', 'Visual group, not a plugin'),
        el('h2', '', group.label),
        el('p', '', group.description),
      );
      heading(group.id === 'external' ? 'Remote systems' : 'Plugins in this group');
      links(
        group.id === 'external'
          ? externals.map((node) => node.id)
          : group.members.filter((id) => nodes.has(id)),
      );
      const edges = data.edges.filter(
        (edge) =>
          nodes.get(edge.from)?.kind === 'service' &&
          groupOf(edge.from) === group.id &&
          groupOf(edge.to) !== group.id,
      );
      if (edges.length) {
        heading('Direct dependencies outside this group');
        relationships(edges);
      }
      return;
    }
    const node = info(target);
    if (!node) return;
    inspector.append(
      el(
        'span',
        'kicker',
        remote.has(target)
          ? 'Remote service'
          : node.kind === 'service'
            ? `${node.runtime === 'machine' ? 'Separate machine' : 'Cordis service'} plugin`
            : `${node.kind.toUpperCase()} adapter`,
      ),
      el('h2', '', node.label),
      el('p', '', node.purpose),
    );
    if (remote.has(target)) {
      heading('Network connection');
      links(['mounts']);
      inspector.append(
        el(
          'p',
          '',
          'Connected over MCP only when configured. It is not an injected Cordis dependency and it is not bundled into this server.',
        ),
      );
      return;
    }
    inspector.append(
      el(
        'span',
        'mode-tag',
        node.defaultConfiguration
          ? 'Included in the default server configuration'
          : node.runtime === 'machine'
            ? 'Configured independently on the machine'
            : 'Optional; not in the default server configuration',
      ),
    );
    const incoming = data.edges.filter((edge) => edge.to === target).map((edge) => edge.from);
    heading(`Requires · ${node.requires.length}`);
    links(node.requires, 'requires');
    if (node.optional?.length) {
      heading(`Optional · ${node.optional.length}`);
      links(node.optional, 'optional');
    }
    heading(`Used by · ${incoming.length}`);
    links(incoming, 'consumers');
    const network = data.network.filter((edge) => edge.from === target || edge.to === target);
    if (network.length) {
      heading('Network connections');
      for (const edge of network) {
        links([edge.from === target ? edge.to : edge.from]);
        inspector.append(el('p', '', `${edge.protocol} · ${edge.description}`));
      }
    }
    heading(`Exposed tools · ${node.exposedTools.length}`);
    if (!node.exposedTools.length)
      inspector.append(
        el(
          'p',
          'empty',
          target === 'mounts'
            ? 'Tools are discovered from configured remote servers. Names use _pluginname.toolname.'
            : 'No native tools. Other plugins use its service contract.',
        ),
      );
    for (const tool of node.exposedTools) {
      const details = el('details', 'tool');
      details.append(el('summary', '', tool.name));
      details.append(el('p', '', tool.description || 'Declared by this plugin’s tool adapter.'));
      if (tool.readOnly) details.append(el('span', 'mode-tag', 'Read-only tool'));
      inspector.append(details);
    }
    if (node.kind === 'service') {
      const adapters = data.nodes.filter(
        (other) => other.kind !== 'service' && other.owner === target,
      );
      if (adapters.length) {
        heading('Its adapters');
        links(adapters.map((a) => a.id));
      }
    }
    inspector.append(el('code', 'source', node.source));
  }

  function members(target) {
    if (!target) return new Set();
    if (target === 'adapters')
      return new Set(data.nodes.filter((n) => n.kind !== 'service').map((n) => n.id));
    if (target.startsWith('group:'))
      return new Set(
        target === 'group:external'
          ? externals.map((n) => n.id)
          : (groups.get(target.slice(6))?.members ?? []),
      );
    return new Set([target]);
  }
  function trace() {
    const target = hovered ?? selected,
      focal = members(target),
      relations = new Map([...focal].map((id) => [id, 'self']));
    const visible = target
      ? data.edges.filter((edge) => focal.has(edge.from) || focal.has(edge.to))
      : data.edges.filter(
          (edge) =>
            nodes.get(edge.from)?.kind === 'service' && groupOf(edge.from) !== groupOf(edge.to),
        );
    for (const edge of visible) {
      if (focal.has(edge.from) && !focal.has(edge.to)) relations.set(edge.to, 'out');
      if (focal.has(edge.to) && !focal.has(edge.from)) relations.set(edge.from, 'in');
    }
    const network = target
      ? data.network.filter((edge) => focal.has(edge.from) || focal.has(edge.to))
      : data.network;
    for (const edge of network)
      for (const id of [edge.from, edge.to]) if (!relations.has(id)) relations.set(id, 'network');
    map.classList.toggle('tracing', !!target);
    for (const b of groupsHost.querySelectorAll('[data-node]')) {
      const relation = relations.get(b.dataset.node);
      if (relation) b.dataset.relation = relation;
      else delete b.dataset.relation;
      b.setAttribute('aria-pressed', String(selected === b.dataset.node));
    }
    for (const card of groupsHost.querySelectorAll('.group'))
      card.classList.toggle(
        'connected',
        [...relations.keys()].some((id) => groupOf(id) === card.dataset.group),
      );
    const out = visible.filter((e) => focal.has(e.from) && !e.optional).length,
      optional = visible.filter((e) => focal.has(e.from) && e.optional).length,
      incoming = visible.filter((e) => focal.has(e.to)).length;
    status.textContent = target
      ? `${target === 'adapters' ? 'Adapters' : target.startsWith('group:') ? groups.get(target.slice(6))?.label : label(target)} · ${out} requires${optional ? ` · ${optional} optional` : ''} · ${incoming} used by${network.length ? ` · ${network.length} network link${network.length === 1 ? '' : 's'}` : ''}`
      : 'Hover a name to trace it. Click to keep it open.';
    draw(visible, network, focal, !!target);
  }

  const svgNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) {
    const e = document.createElementNS(svgNS, tag);
    Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, String(v)));
    return e;
  }
  function draw(edges, network, focal, active) {
    const base = map.getBoundingClientRect();
    if (!base.width) return;
    wires.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
    wires.replaceChildren();
    const defs = svg('defs', {});
    for (const [name, color] of [
      ['normal', '#aaa99c'],
      ['out', '#8a4f30'],
      ['in', '#4e6d70'],
      ['net', '#757668'],
    ]) {
      const marker = svg('marker', {
        id: `arrow-${name}`,
        viewBox: '0 0 10 10',
        refX: 9,
        refY: 5,
        markerWidth: 7,
        markerHeight: 7,
        orient: 'auto-start-reverse',
        markerUnits: 'userSpaceOnUse',
      });
      marker.append(
        svg('path', { d: 'M 1 1 L 9 5 L 1 9', fill: 'none', stroke: color, 'stroke-width': 1.3 }),
      );
      defs.append(marker);
    }
    wires.append(defs);
    const boxes = new Map(
      [...groupsHost.querySelectorAll('.group')].map((card) => {
        const r = card.getBoundingClientRect();
        return [
          card.dataset.group,
          { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height },
        ];
      }),
    );
    const condensed = new Map();
    for (const edge of edges) {
      const from = groupOf(edge.from),
        to = groupOf(edge.to);
      if (!from || !to || (!active && from === to)) continue;
      const type = active ? (focal.has(edge.from) ? 'out' : 'in') : 'normal';
      const key = `${from}|${to}|${type}`;
      if (!condensed.has(key)) condensed.set(key, { from, to, type, edges: [] });
      condensed.get(key).edges.push(edge);
    }
    for (const edge of network) {
      const from = groupOf(edge.from),
        to = groupOf(edge.to),
        key = `${from}|${to}|net`;
      if (!condensed.has(key)) condensed.set(key, { from, to, type: 'net', edges: [] });
      condensed.get(key).edges.push(edge);
    }
    for (const edge of condensed.values()) {
      const a = boxes.get(edge.from),
        b = boxes.get(edge.to);
      if (!a || !b) continue;
      let path;
      if (edge.from === edge.to) {
        const first = edge.edges[0];
        const targetA = groupsHost.querySelector(`[data-node="${CSS.escape(first.from)}"]`),
          targetB = groupsHost.querySelector(`[data-node="${CSS.escape(first.to)}"]`);
        if (!targetA || !targetB) continue;
        const ra = targetA.getBoundingClientRect(),
          rb = targetB.getBoundingClientRect();
        const start = [ra.left - base.left - 2, ra.top - base.top + ra.height / 2],
          end = [rb.left - base.left - 2, rb.top - base.top + rb.height / 2];
        path = `M ${start} C ${a.x - 15},${start[1]} ${a.x - 15},${end[1]} ${end}`;
      } else {
        const points = route(a, b, [...boxes.values()], base.width, base.height);
        path = points
          .map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
          .join(' ');
      }
      const line = svg('path', {
        d: path,
        class: `wire ${edge.type === 'out' ? 'focus' : edge.type === 'in' ? 'used' : edge.type === 'net' ? 'net' : ''}`,
        'marker-end': `url(#arrow-${edge.type})`,
      });
      if (edge.type === 'net') line.setAttribute('marker-start', 'url(#arrow-net)');
      const title = svg('title', {});
      title.textContent = edge.edges
        .map(
          (e) =>
            `${label(e.from)} ${e.protocol ? '↔' : e.optional ? 'optionally uses' : 'requires'} ${label(e.to)}`,
        )
        .join('\n');
      line.append(title);
      wires.append(line);
    }
  }
  function route(a, b, boxes, width, height) {
    const ports = (r) => [
      [
        [r.x + r.w / 2, r.y - 3],
        [r.x + r.w / 2, r.y - 17],
      ],
      [
        [r.x + r.w + 3, r.y + r.h / 2],
        [r.x + r.w + 17, r.y + r.h / 2],
      ],
      [
        [r.x + r.w / 2, r.y + r.h + 3],
        [r.x + r.w / 2, r.y + r.h + 17],
      ],
      [
        [r.x - 3, r.y + r.h / 2],
        [r.x - 17, r.y + r.h / 2],
      ],
    ];
    const xs = [5, width - 5, ...boxes.flatMap((r) => [r.x - 17, r.x + r.w + 17])],
      ys = [5, height - 5, ...boxes.flatMap((r) => [r.y - 17, r.y + r.h + 17])];
    const blocked = (p, q) =>
      boxes.some((r) =>
        p[0] === q[0]
          ? p[0] > r.x - 5 &&
            p[0] < r.x + r.w + 5 &&
            Math.max(p[1], q[1]) > r.y - 5 &&
            Math.min(p[1], q[1]) < r.y + r.h + 5
          : p[1] > r.y - 5 &&
            p[1] < r.y + r.h + 5 &&
            Math.max(p[0], q[0]) > r.x - 5 &&
            Math.min(p[0], q[0]) < r.x + r.w + 5,
      );
    let best = null,
      cost = Infinity;
    for (const [anchorA, p] of ports(a))
      for (const [anchorB, q] of ports(b)) {
        const candidates = [
          [p, [p[0], q[1]], q],
          [p, [q[0], p[1]], q],
          ...xs.filter((x) => x >= 0 && x <= width).map((x) => [p, [x, p[1]], [x, q[1]], q]),
          ...ys.filter((y) => y >= 0 && y <= height).map((y) => [p, [p[0], y], [q[0], y], q]),
        ];
        for (const raw of candidates) {
          const points = raw.filter(
            (point, i) => i === 0 || point[0] !== raw[i - 1][0] || point[1] !== raw[i - 1][1],
          );
          if (points.some((point, i) => i > 0 && blocked(points[i - 1], point))) continue;
          const length =
            points.reduce(
              (sum, point, i) =>
                sum +
                (i
                  ? Math.abs(point[0] - points[i - 1][0]) + Math.abs(point[1] - points[i - 1][1])
                  : 0),
              0,
            ) +
            points.length * 11;
          if (length < cost) {
            cost = length;
            best = [anchorA, ...points, anchorB];
          }
        }
      }
    return (
      best ?? [
        [a.x + a.w / 2, a.y + a.h],
        [a.x + a.w / 2, b.y - 18],
        [b.x + b.w / 2, b.y - 18],
        [b.x + b.w / 2, b.y - 3],
      ]
    );
  }

  function select(target) {
    selected = target;
    hovered = null;
    showDetails(target);
    trace();
    dependencyDAG.setSelected(target);
    detailJump.hidden = !target;
    detailJump.textContent = 'View details ↓';
    announcement.textContent = target
      ? `${target.startsWith('group:') ? groups.get(target.slice(6))?.label : target === 'adapters' ? 'Adapters' : label(target)} details selected.`
      : 'Whole map.';
    updateLocation();
  }
  function updateLocation() {
    const hash =
      currentView === 'tree'
        ? `#dag${selected ? '/' + encodeURIComponent(selected) : ''}`
        : selected
          ? `#${encodeURIComponent(selected)}`
          : location.pathname + location.search;
    try {
      history.replaceState(null, '', hash);
    } catch {
      /* file and embedded previews may restrict history */
    }
  }
  const dependencyDAG = createDependencyDAG({ data, select });
  function setView(view) {
    currentView = view;
    for (const id of ['map', 'tree']) {
      document.getElementById(`${id}-page`).hidden = id !== view;
      document.getElementById(`${id}-view`).setAttribute('aria-pressed', String(id === view));
    }
    hovered = null;
    dependencyDAG.setSelected(selected);
    if (view === 'map') requestAnimationFrame(trace);
    updateLocation();
  }
  for (const id of ['map', 'tree'])
    document.getElementById(`${id}-view`).addEventListener('click', () => setView(id));
  document.getElementById('overview').addEventListener('click', () => select(null));
  detailJump.addEventListener('click', () => {
    const atDetails = inspector.getBoundingClientRect().top < window.innerHeight * 0.6;
    (atDetails ? document.getElementById(`${currentView}-page`) : inspector).scrollIntoView({
      block: 'start',
    });
  });
  new IntersectionObserver(([entry]) => {
    detailJump.textContent = entry.isIntersecting ? 'Back to map ↑' : 'View details ↓';
  }).observe(inspector);
  for (const host of [groupsHost, inspector])
    host.addEventListener('click', (event) => {
      const b = event.target.closest('button[data-target]');
      if (b) select(b.dataset.target);
    });
  groupsHost.addEventListener('pointerover', (event) => {
    const b = event.target.closest('button[data-target]');
    if (b && hovered !== b.dataset.target) {
      hovered = b.dataset.target;
      trace();
    }
  });
  groupsHost.addEventListener('pointerleave', () => {
    hovered = null;
    trace();
  });
  groupsHost.addEventListener('pointerout', (event) => {
    const b = event.target.closest('button[data-target]');
    if (b && !b.contains(event.relatedTarget)) {
      hovered = null;
      trace();
    }
  });
  groupsHost.addEventListener('focusin', (event) => {
    const b = event.target.closest('button[data-target]');
    if (b) {
      hovered = b.dataset.target;
      trace();
    }
  });
  groupsHost.addEventListener('focusout', (event) => {
    if (!groupsHost.contains(event.relatedTarget)) {
      hovered = null;
      trace();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') select(null);
  });
  const resize = new ResizeObserver(() => {
    cancelAnimationFrame(pendingFrame);
    pendingFrame = requestAnimationFrame(trace);
  });
  resize.observe(groupsHost);
  function restoreLocation() {
    currentView = 'map';
    selected = null;
    let initial;
    try {
      initial = decodeURIComponent(location.hash.slice(1));
    } catch {
      initial = '';
    }
    if (
      initial === 'dag' ||
      initial.startsWith('dag/') ||
      initial === 'tree' ||
      initial.startsWith('tree/')
    ) {
      currentView = 'tree';
      initial = initial.includes('/') ? initial.slice(initial.indexOf('/') + 1) : '';
    }
    if (
      initial &&
      (nodes.has(initial) ||
        remote.has(initial) ||
        initial === 'adapters' ||
        (initial.startsWith('group:') && groups.has(initial.slice(6))))
    )
      selected = initial;
    detailJump.hidden = !selected;
    showDetails(selected);
    setView(currentView);
  }
  window.addEventListener('hashchange', restoreLocation);
  restoreLocation();
  requestAnimationFrame(trace);
})();
