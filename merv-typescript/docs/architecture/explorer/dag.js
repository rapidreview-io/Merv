/* Layered DAG layout. Intermediate routing points are not plugin nodes. */
function createDependencyDAG({ data, select }) {
  const viewport = document.getElementById('dag-viewport');
  const space = document.getElementById('dag-space');
  const canvas = document.getElementById('dag-canvas');
  const host = document.getElementById('dag-nodes');
  const wires = document.getElementById('dag-edges');
  const search = document.getElementById('dag-search');
  const picker = document.getElementById('dag-jump');
  const status = document.getElementById('dag-status');
  const adapterToggle = document.getElementById('dag-adapters');
  const nodeHeight = 100;
  let hideAdapters = false;
  let visibleNodes, nodes, incoming, vertices, routes, graphWidth, graphHeight;
  const make = (tag, className, text) => {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const svg = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  };
  function buildGraph() {
    const active = data.nodes.filter((node) => !hideAdapters || node.kind === 'service');
    const ids = new Set(active.map((node) => node.id));
    visibleNodes = active.map((node) => ({
      ...node,
      requires: node.requires.filter((id) => ids.has(id)),
      optional: (node.optional ?? []).filter((id) => ids.has(id)),
    }));
    const visibleEdges = data.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    host.replaceChildren();
    wires.replaceChildren();
    nodes = new Map(visibleNodes.map((node) => [node.id, node]));
    incoming = new Map(visibleNodes.map((node) => [node.id, []]));
    for (const edge of visibleEdges) incoming.get(edge.to).push(edge.from);
    const ranks = new Map();
    const visiting = new Set();
    function rank(id) {
      if (ranks.has(id)) return ranks.get(id);
      if (visiting.has(id)) throw new Error('Plugin dependency graph contains a cycle');
      visiting.add(id);
      const node = nodes.get(id);
      const depth = Math.max(-1, ...[...node.requires, ...node.optional].map(rank)) + 1;
      visiting.delete(id);
      ranks.set(id, depth);
      return depth;
    }
    visibleNodes.forEach((node) => rank(node.id));
    // Put shared foundations at the bottom and consumers above their deepest dependency.
    const maximumDepth = Math.max(...ranks.values());
    for (const [id, depth] of ranks) ranks.set(id, maximumDepth - depth);
    const levels = Array.from({ length: Math.max(...ranks.values()) + 1 }, () => []);
    vertices = new Map();
    for (const node of visibleNodes) {
      const vertex = {
        id: node.id,
        rank: ranks.get(node.id),
        real: true,
        parents: [],
        children: [],
        width: 176,
      };
      levels[vertex.rank].push(vertex);
      vertices.set(vertex.id, vertex);
    }
    routes = visibleEdges.map((edge, index) => {
      const points = [vertices.get(edge.from)];
      for (let r = ranks.get(edge.from) + 1; r < ranks.get(edge.to); r++) {
        const point = {
          id: `route-${index}-${r}`,
          rank: r,
          real: false,
          parents: [],
          children: [],
          width: 12,
        };
        levels[r].push(point);
        points.push(point);
      }
      points.push(vertices.get(edge.to));
      for (let i = 1; i < points.length; i++) {
        points[i - 1].children.push(points[i]);
        points[i].parents.push(points[i - 1]);
      }
      return { ...edge, points };
    });
    const assignOrder = () =>
      levels.forEach((level) => level.forEach((point, i) => (point.order = i)));
    assignOrder();
    // Barycenter sweeps keep related nodes near each other and reduce crossings.
    for (let pass = 0; pass < 12; pass++) {
      const down = pass % 2 === 0;
      for (const level of down ? levels.slice(1) : levels.slice(0, -1).reverse()) {
        const score = (point) => {
          const near = down ? point.parents : point.children;
          return near.length
            ? near.reduce((sum, p) => sum + p.order, 0) / near.length
            : point.order;
        };
        level.sort((a, b) => score(a) - score(b) || a.order - b.order);
        assignOrder();
      }
    }
    const gap = 30,
      rowGap = 204,
      pad = 70;
    const widths = levels.map((level) => level.reduce((sum, v) => sum + v.width + gap, 0) - gap);
    graphWidth = Math.max(...widths) + pad * 2;
    graphHeight = levels.length * rowGap + pad * 2;
    levels.forEach((level, r) => {
      let x = (graphWidth - widths[r]) / 2;
      for (const point of level) {
        point.x = x + point.width / 2;
        point.y = pad + r * rowGap;
        x += point.width + gap;
      }
    });
    canvas.style.width = `${graphWidth}px`;
    canvas.style.height = `${graphHeight}px`;
    wires.setAttribute('viewBox', `0 0 ${graphWidth} ${graphHeight}`);
    const defs = svg('defs', {});
    for (const [id, color] of [
      ['normal', '#9d927e'],
      ['out', '#8a4f30'],
      ['in', '#4e6d70'],
    ]) {
      const marker = svg('marker', {
        id: `dag-arrow-${id}`,
        viewBox: '0 0 10 10',
        refX: 9,
        refY: 5,
        markerWidth: 8,
        markerHeight: 8,
        orient: 'auto',
        markerUnits: 'userSpaceOnUse',
      });
      marker.append(
        svg('path', { d: 'M 1 1 L 9 5 L 1 9', fill: 'none', stroke: color, 'stroke-width': 1.6 }),
      );
      defs.append(marker);
    }
    wires.append(defs);
    for (const route of routes) {
      const coords = route.points.map((point, i) => [
        point.x,
        point.y + (i === 0 ? nodeHeight : i === route.points.length - 1 ? 0 : nodeHeight / 2),
      ]);
      let d = `M ${coords[0].join(' ')}`;
      for (let i = 1; i < coords.length; i++) {
        const [x, y] = coords[i],
          p = coords[i - 1],
          mid = (p[1] + y) / 2;
        d += ` C ${p[0]} ${mid} ${x} ${mid} ${x} ${y}`;
      }
      const path = svg('path', { d, class: 'dag-edge', 'marker-end': 'url(#dag-arrow-normal)' });
      if (route.optional) path.setAttribute('stroke-dasharray', '6 5');
      const title = svg('title', {});
      title.textContent = `${route.from} ${route.optional ? 'optionally uses' : 'requires'} ${route.to}`;
      path.append(title);
      path.dataset.from = route.from;
      path.dataset.to = route.to;
      wires.append(path);
    }
    for (const node of visibleNodes) {
      const point = vertices.get(node.id);
      const card = make('button', `dag-node ${node.kind === 'service' ? 'service' : 'adapter'}`);
      card.type = 'button';
      card.dataset.node = node.id;
      card.setAttribute('aria-pressed', 'false');
      card.title = node.purpose;
      card.style.left = `${point.x - 88}px`;
      card.style.top = `${point.y}px`;
      card.append(
        make('span', 'dag-name', node.label),
        make(
          'span',
          'dag-kind',
          node.runtime === 'machine'
            ? 'Separate machine'
            : node.kind === 'service'
              ? 'Service plugin'
              : `${node.kind.toUpperCase()} adapter`,
        ),
        make(
          'span',
          'dag-meta',
          `${node.requires.length} required${node.optional.length ? ` + ${node.optional.length} optional` : ''} · ${incoming.get(node.id).length} used by`,
        ),
      );
      host.append(card);
    }
  }
  buildGraph();
  let selected = null,
    zoom = 1,
    fitting = true,
    offsetX = 20;
  function highlight(id) {
    const node = nodes.get(id),
      out = new Set([...(node?.requires ?? []), ...(node?.optional ?? [])]),
      ins = new Set(incoming.get(id) ?? []);
    canvas.classList.toggle('tracing', !!node);
    for (const card of host.children) {
      const n = card.dataset.node,
        type = n === id ? 'self' : out.has(n) ? 'out' : ins.has(n) ? 'in' : '';
      if (type) card.dataset.relation = type;
      else delete card.dataset.relation;
      card.setAttribute('aria-pressed', String(n === selected));
    }
    for (const path of wires.querySelectorAll('.dag-edge')) {
      const type = path.dataset.from === id ? 'out' : path.dataset.to === id ? 'in' : '';
      if (type) path.dataset.relation = type;
      else delete path.dataset.relation;
      path.setAttribute('marker-end', `url(#dag-arrow-${type || 'normal'})`);
    }
    status.textContent = node
      ? `${node.label} · ${node.requires.length} required · ${node.optional.length} optional (dashed) · ${ins.size} used by. All ${nodes.size} nodes remain visible.`
      : 'Hover or focus a plugin to trace its direct relationships. Click for details.';
    document.getElementById('dag-selected').disabled = !nodes.has(selected);
  }
  function layout() {
    if (!viewport.clientWidth) return;
    if (fitting)
      zoom = Math.min(
        1,
        Math.max(
          0.05,
          Math.min(
            (viewport.clientWidth - 40) / graphWidth,
            (viewport.clientHeight - 40) / graphHeight,
          ),
        ),
      );
    offsetX = Math.max(20, (viewport.clientWidth - graphWidth * zoom) / 2);
    canvas.style.transform = `scale(${zoom})`;
    canvas.style.left = `${offsetX}px`;
    space.style.width = `${Math.max(viewport.clientWidth - 2, graphWidth * zoom + 40)}px`;
    space.style.height = `${Math.max(viewport.clientHeight - 2, graphHeight * zoom + 40)}px`;
    document.getElementById('dag-scale').textContent = `${Math.round(zoom * 100)}%`;
  }
  function changeZoom(next, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) {
    const gx = (viewport.scrollLeft + x - offsetX) / zoom,
      gy = (viewport.scrollTop + y - 20) / zoom;
    fitting = false;
    zoom = Math.min(2, Math.max(0.05, next));
    layout();
    viewport.scrollLeft = gx * zoom + offsetX - x;
    viewport.scrollTop = gy * zoom + 20 - y;
  }
  function center(id, readable = true) {
    const point = vertices.get(id);
    if (!point) return;
    if (readable && zoom < 0.75) {
      fitting = false;
      zoom = 0.85;
      layout();
    }
    viewport.scrollLeft = point.x * zoom + offsetX - viewport.clientWidth / 2;
    viewport.scrollTop = (point.y + nodeHeight / 2) * zoom + 20 - viewport.clientHeight / 2;
  }
  function jump(id) {
    if (!nodes.has(id)) return;
    select(id);
    center(id);
  }
  function searchOptions() {
    const query = search.value.trim().toLowerCase();
    const found = visibleNodes
      .filter((node) => `${node.label} ${node.id} ${node.source}`.toLowerCase().includes(query))
      .sort((a, b) => a.label.localeCompare(b.label));
    picker.replaceChildren();
    const prompt = make('option', '', found.length ? 'Choose a plugin…' : 'No matches');
    prompt.value = '';
    picker.append(prompt);
    for (const node of found) {
      const option = make('option', '', node.label);
      option.value = node.id;
      picker.append(option);
    }
    for (const card of host.children)
      card.classList.toggle(
        'search-match',
        !!query && found.some((n) => n.id === card.dataset.node),
      );
    document.getElementById('dag-count').textContent =
      `${nodes.size} unique plugins · ${routes.length} directed dependencies · ${hideAdapters ? 'adapters hidden · ' : ''}${query ? found.length + ' search matches · ' : ''}fully expanded`;
  }
  adapterToggle.addEventListener('click', () => {
    hideAdapters = !hideAdapters;
    adapterToggle.setAttribute('aria-pressed', String(hideAdapters));
    buildGraph();
    if (selected && !nodes.has(selected)) select(null);
    searchOptions();
    highlight(selected);
    fitting = true;
    layout();
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
  });
  search.addEventListener('input', searchOptions);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && picker.options.length > 1) jump(picker.options[1].value);
  });
  picker.addEventListener('change', () => jump(picker.value));
  host.addEventListener('click', (event) => {
    const card = event.target.closest('.dag-node');
    if (card) select(card.dataset.node);
  });
  for (const name of ['pointerover', 'focusin'])
    host.addEventListener(name, (event) => {
      const card = event.target.closest('.dag-node');
      if (card) highlight(card.dataset.node);
    });
  for (const name of ['pointerout', 'focusout'])
    host.addEventListener(name, (event) => {
      const card = event.target.closest('.dag-node');
      if (card && !card.contains(event.relatedTarget)) highlight(selected);
    });
  for (const id of ['knowledge', 'ui'])
    document.getElementById(`dag-${id}`).addEventListener('click', () => jump(id));
  document.getElementById('dag-selected').addEventListener('click', () => center(selected));
  document.getElementById('dag-clear').addEventListener('click', () => {
    search.value = '';
    searchOptions();
    select(null);
  });
  document.getElementById('dag-minus').addEventListener('click', () => changeZoom(zoom / 1.3));
  document.getElementById('dag-plus').addEventListener('click', () => changeZoom(zoom * 1.3));
  document.getElementById('dag-actual').addEventListener('click', () => changeZoom(1));
  document.getElementById('dag-fit').addEventListener('click', () => {
    fitting = true;
    layout();
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
  });
  viewport.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const r = viewport.getBoundingClientRect();
        changeZoom(
          zoom * Math.exp(-event.deltaY * 0.01),
          event.clientX - r.left,
          event.clientY - r.top,
        );
      }
    },
    { passive: false },
  );
  let drag;
  viewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button')) return;
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('dragging');
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    viewport.scrollLeft = drag.left - (event.clientX - drag.x);
    viewport.scrollTop = drag.top - (event.clientY - drag.y);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'])
    viewport.addEventListener(name, () => {
      drag = null;
      viewport.classList.remove('dragging');
    });
  new ResizeObserver(() => requestAnimationFrame(layout)).observe(viewport);
  searchOptions();
  highlight(null);
  requestAnimationFrame(layout);
  return {
    setSelected(id) {
      selected = id;
      highlight(id);
    },
  };
}
