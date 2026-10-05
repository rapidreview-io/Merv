/* Merv Atlas viewer. Everything drawn here is derived from window.ATLAS, which
   scripts/atlas.ts compiles from source; nothing about a particular plugin is written here. */
(() => {
  'use strict';
  const A = window.ATLAS;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.getElementById('map');
  const cameraG = document.getElementById('camera');
  const landG = document.getElementById('land');
  const edgeG = document.getElementById('edges');
  const nodeG = document.getElementById('nodes');
  const sceneG = document.getElementById('scene');
  const card = document.getElementById('card');
  const crumbs = document.getElementById('crumbs');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const TAU = Math.PI * 2;
  const RESEARCH = 'research*';

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs || {})
      if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false)
        e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  const esc = (s) =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
    );
  const polar = (r, a) => [Math.cos(a) * r, Math.sin(a) * r];
  const deg = (d) => (d * Math.PI) / 180;
  const norm = (a) => ((a % TAU) + TAU) % TAU;
  const adiff = (a, b) => {
    const d = Math.abs(norm(a) - norm(b));
    return Math.min(d, TAU - d);
  };
  const cmean = (angles) => {
    if (!angles.length) return null;
    let x = 0,
      y = 0;
    for (const a of angles) {
      x += Math.cos(a);
      y += Math.sin(a);
    }
    return Math.atan2(y, x);
  };
  const arcD = (r, a0, a1) => {
    const [x0, y0] = polar(r, a0),
      [x1, y1] = polar(r, a1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };

  /* ---------------- icons (no words where a glyph will do) ---------------- */
  const ICON = {
    globe:
      '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>',
    flask:
      '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/><path d="M7.5 15h9"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    find: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/>',
    method: '<circle cx="12" cy="12" r="5" fill="currentColor"/>',
    hook: '<circle cx="12" cy="12" r="5.5" stroke-width="3"/>',
    tool: '<path d="M12 4l7 8-7 8-7-8z" fill="currentColor"/>',
    event: '<path d="M6 18l6-12 6 12z" fill="currentColor"/>',
    table:
      '<ellipse cx="12" cy="6.5" rx="7" ry="2.5"/><path d="M5 6.5v11c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-11"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/>',
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
    agent:
      '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>',
  };
  const icon = (name, color) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="${color || 'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

  /* ---------------- data ---------------- */
  const P = new Map(A.plugins.map((p) => [p.id, p]));
  const members = new Map();
  for (const p of A.plugins)
    for (const s of p.services)
      for (const m of s.members)
        members.set(s.key + '.' + m.name, { ...m, service: s.key, owner: p.id });
  const machinesOf = (id) => A.stateMachines.filter((m) => m.owner === id);
  const machineHost = (
    A.plugins.find((p) =>
      p.services.some((s) =>
        s.members.some((m) => m.params.some((x) => /WorkflowDefinition/.test(x.type))),
      ),
    ) || {}
  ).id;
  const label = (id) =>
    id === RESEARCH ? 'Research' : id === '@agents' ? 'Agents' : (P.get(id) || {}).label || id;

  const KINDS = [
    ['call', 'Calls a service method', 'var(--call)', 'Calls'],
    ['hook', 'Calls back into a plugin that registered with it', 'var(--hook)', 'Hooks'],
    ['event', 'Domain event: written by one, consumed by another', 'var(--event)', 'Events'],
    ['tool', 'Calls another plugin’s tool', 'var(--tool)', 'Tool calls'],
    ['table', 'Queries tables another plugin owns', 'var(--table)', 'Table reads'],
    ['http', 'Network call between processes', 'var(--http)', 'HTTP'],
    ['idle', 'Declared dependency, no call found in source', 'var(--idle)', 'Unused deps'],
  ];
  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many || one + 's'}`;
  const nameList = (ids) => {
    const names = ids.map((id) => esc(label(id)));
    return names.length < 3
      ? names.join(' and ')
      : names.slice(0, -1).join(', ') + ' and ' + names.at(-1);
  };
  const sentence = (c) => {
    const a = `<b>${esc(label(c.from))}</b>`,
      b = `<b>${esc(label(c.to))}</b>`,
      n = c.items.length;
    if (c.kind === 'call') return `${a} calls ${plural(n, 'method')} on ${b}.`;
    if (c.kind === 'hook')
      return `${a} calls back into ${b} through ${plural(n, 'hook')} that ${b} registered.`;
    if (c.kind === 'event') return `${a} emits ${plural(n, 'event')} that ${b} consumes.`;
    if (c.kind === 'tool') return `${a} calls ${plural(n, 'tool')} that ${b} offers to agents.`;
    if (c.kind === 'table') {
      const runtime = c.items.filter((t) => t.runtime > 0).length;
      return `${a} queries ${plural(n, 'table')} owned by ${b} directly${runtime ? '' : ', only in migrations'}.`;
    }
    if (c.kind === 'http') return `${a} reaches ${b} over the network (${esc(c.items[0].name)}).`;
    return `${a} declares ${b} as a dependency, but no call to it was found in the code.`;
  };

  const channels = [];
  for (const e of A.edges) {
    if (e.kind === 'call') {
      const items = [];
      for (const [svc, methods] of Object.entries(e.services))
        for (const [name, v] of Object.entries(methods))
          items.push({
            svc,
            name,
            count: v.count,
            sites: v.sites,
            hook: !!(members.get(svc + '.' + name) || {}).hook,
          });
      if (!items.length) {
        channels.push({ kind: 'idle', from: e.from, to: e.to, items, declared: e.declared });
        continue;
      }
      channels.push({ kind: 'call', from: e.from, to: e.to, items, declared: e.declared });
      const hooks = items.filter((i) => i.hook);
      if (hooks.length)
        channels.push({
          kind: 'hook',
          from: e.to,
          to: e.from,
          items: hooks,
          declared: e.declared,
          derived: true,
        });
    } else if (e.kind === 'event')
      channels.push({
        kind: 'event',
        from: e.from,
        to: e.to,
        items: e.types.map((t) => ({ name: t })),
      });
    else if (e.kind === 'table')
      channels.push({
        kind: 'table',
        from: e.from,
        to: e.to,
        items: Object.entries(e.tables).map(([name, v]) => ({
          name,
          runtime: v.runtime,
          migration: v.migration,
          files: v.files,
        })),
      });
    else if (e.kind === 'tool')
      channels.push({
        kind: 'tool',
        from: e.from,
        to: e.to,
        items: Object.entries(e.tools).map(([name, v]) => ({
          name,
          count: v.count,
          sites: v.sites,
        })),
      });
    else if (e.kind === 'http')
      channels.push({ kind: 'http', from: e.from, to: e.to, items: [{ name: e.protocol }] });
  }

  const surface = (p) => {
    const ms = p.services.flatMap((s) => s.members);
    return {
      method: ms.filter((m) => !m.hook).length,
      hook: ms.filter((m) => m.hook).length,
      tool: p.tools.length,
      event: p.emits.length,
      table: p.tables.length,
    };
  };

  /* ---------------- state ---------------- */
  let showResearch = false;
  let W = innerWidth,
    H = innerHeight;
  let cam = { x: 0, y: 0, k: 1 };
  let worldBox = null;
  const pos = new Map(); // world id -> {x, y, r}
  let focus = null; // { id, k }
  let pinned = false;

  /* ---------------- camera ---------------- */
  function applyCam() {
    cameraG.setAttribute(
      'transform',
      `translate(${W / 2} ${H / 2}) scale(${cam.k}) translate(${-cam.x} ${-cam.y})`,
    );
  }
  let anim = 0;
  function fly(to, ms, done) {
    cancelAnimationFrame(anim);
    if (reduced || !ms) {
      cam = { ...to };
      applyCam();
      if (done) done();
      return;
    }
    const from = { ...cam },
      t0 = performance.now();
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms),
        e = ease(t);
      cam = {
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        k: Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * e),
      };
      applyCam();
      if (t < 1) anim = requestAnimationFrame(step);
      else if (done) done();
    };
    anim = requestAnimationFrame(step);
  }
  const panelWidth = () => {
    const g = document.getElementById('guide');
    return g && g.querySelector('h2') && W > 900 ? g.offsetWidth + 24 : 0;
  };
  const fitTo = (b, pad = 50) => {
    const left = panelWidth();
    const k = Math.min((W - left - pad * 2) / (b.x1 - b.x0), (H - pad * 2) / (b.y1 - b.y0));
    return { x: (b.x0 + b.x1) / 2 - left / 2 / k, y: (b.y0 + b.y1) / 2, k };
  };

  /* ---------------- world ---------------- */
  const mapId = (id) => (!showResearch && (P.get(id) || {}).realm === 'research' ? RESEARCH : id);
  function worldNodes() {
    const nodes = A.plugins
      .filter((p) => showResearch || p.realm !== 'research')
      .map((p) => ({ id: p.id, p, loc: p.loc, realm: p.realm }));
    if (!showResearch) {
      const rs = A.plugins.filter((p) => p.realm === 'research');
      nodes.push({
        id: RESEARCH,
        p: null,
        loc: rs.reduce((n, p) => n + p.loc, 0),
        realm: 'research',
        members: rs.map((p) => p.id),
      });
    }
    return nodes;
  }
  function worldChannels() {
    const merged = new Map();
    for (const ch of channels) {
      const from = mapId(ch.from),
        to = mapId(ch.to);
      if (from === to) continue;
      const key = ch.kind + '|' + from + '|' + to;
      const m = merged.get(key) || {
        kind: ch.kind,
        from,
        to,
        items: [],
        undeclared: false,
        parts: [],
      };
      m.items.push(...ch.items);
      m.parts.push(ch);
      if (ch.kind === 'call' && ch.declared === null) m.undeclared = true;
      merged.set(key, m);
    }
    return [...merged.values()];
  }
  const radius = (loc) => 6 + Math.sqrt(loc) * 0.2;

  function layoutWorld(nodes, chs) {
    const deps = new Map(nodes.map((n) => [n.id, new Set()]));
    for (const c of chs) {
      const declaredDep =
        (c.kind === 'call' || c.kind === 'idle') && c.parts.some((p) => p.declared);
      if ((declaredDep || c.kind === 'http') && deps.has(c.from) && deps.has(c.to))
        deps.get(c.from).add(c.to);
    }
    const level = new Map(),
      visiting = new Set();
    const lv = (id) => {
      if (level.has(id)) return level.get(id);
      if (visiting.has(id)) return 0;
      visiting.add(id);
      let l = 0;
      for (const d of deps.get(id)) l = Math.max(l, lv(d) + 1);
      visiting.delete(id);
      level.set(id, l);
      return l;
    };
    nodes.forEach((n) => {
      n.r = radius(n.loc);
      n.level = lv(n.id);
    });
    const rows = [];
    for (const n of nodes) (rows[n.level] = rows[n.level] || []).push(n);
    const adj = new Map(nodes.map((n) => [n.id, []]));
    for (const c of chs)
      if (adj.has(c.from) && adj.has(c.to) && c.kind !== 'hook') {
        adj.get(c.from).push(c.to);
        adj.get(c.to).push(c.from);
      }
    const width = (n) => Math.max(n.r * 2 + 46, label(n.id).length * 8 + 26);
    const place = (row) => {
      const total = row.reduce((s, n) => s + width(n), 0);
      let x = -total / 2;
      for (const n of row) {
        n.x = x + width(n) / 2;
        x += width(n);
      }
    };
    rows.forEach((row) => {
      row.sort((a, b) => a.id.localeCompare(b.id));
      place(row);
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (let sweep = 0; sweep < 16; sweep++) {
      const order = sweep % 2 ? rows.map((_, i) => rows.length - 1 - i) : rows.map((_, i) => i);
      for (const i of order) {
        const row = rows[i];
        if (!row) continue;
        for (const n of row) {
          const xs = adj
            .get(n.id)
            .map((id) => byId.get(id))
            .filter((m) => m && m.level !== n.level)
            .map((m) => m.x);
          n.bary = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : n.x;
        }
        row.sort((a, b) => a.bary - b.bary || a.id.localeCompare(b.id));
        place(row);
      }
    }
    // Settle the layered start into a map: springs along channels, repulsion between plugins,
    // and a weak pull toward each plugin's depth so foundations stay south.
    const ROW = 170;
    const regionsOf = new Map();
    const placedIn = new Set();
    for (const region of A.regions || [])
      for (const id of region.members) {
        const n = byId.get(mapId(id));
        if (!n || placedIn.has(n.id)) continue;
        placedIn.add(n.id);
        regionsOf.set(region.label, [...(regionsOf.get(region.label) || []), n]);
      }
    for (const n of nodes) {
      n.y = -n.level * ROW;
      n.x *= 1.6;
    }
    const links = chs
      .filter((c) => c.kind === 'call' || c.kind === 'idle')
      .map((c) => ({
        a: byId.get(c.from),
        b: byId.get(c.to),
        w: 1 + Math.log2(1 + c.items.length),
      }))
      .filter((l) => l.a && l.b);
    for (let it = 0; it < 420; it++) {
      const cool = 1 - it / 420;
      for (let i = 0; i < nodes.length; i++)
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i],
            b = nodes[j];
          let dx = b.x - a.x,
            dy = b.y - a.y;
          let d = Math.hypot(dx, dy);
          if (d < 0.01) {
            dx = 0.01 * (i - j);
            dy = 0.01;
            d = 0.014;
          }
          const want = a.r + b.r + 150;
          const f = d < want ? (want - d) * 0.5 : ((want * want * 12) / (d * d * d)) * 4;
          a.x -= (dx / d) * f;
          a.y -= (dy / d) * f * 0.6;
          b.x += (dx / d) * f;
          b.y += (dy / d) * f * 0.6;
        }
      for (const l of links) {
        const dx = l.b.x - l.a.x,
          dy = l.b.y - l.a.y,
          d = Math.hypot(dx, dy) || 1;
        const f = (d - (l.a.r + l.b.r + 230)) * 0.004 * l.w * cool;
        l.a.x += (dx / d) * f;
        l.a.y += (dy / d) * f;
        l.b.x -= (dx / d) * f;
        l.b.y -= (dy / d) * f;
      }
      for (const n of nodes) {
        n.y += (-n.level * ROW - n.y) * 0.05;
        n.x *= 0.998;
      }
      for (const members of regionsOf.values()) {
        if (members.length < 2) continue;
        const cx = members.reduce((s, n) => s + n.x, 0) / members.length;
        const cy = members.reduce((s, n) => s + n.y, 0) / members.length;
        for (const n of members) {
          n.x += (cx - n.x) * 0.03 * cool;
          n.y += (cy - n.y) * 0.015 * cool;
        }
      }
    }
    pos.clear();
    for (const n of nodes) pos.set(n.id, { x: n.x, y: n.y, r: n.r });
    return rows.filter(Boolean);
  }

  function ringSegments(g, p, r, width) {
    const s = surface(p);
    const parts = [
      ['method', s.method],
      ['hook', s.hook],
      ['tool', s.tool],
      ['event', s.event],
      ['table', s.table],
    ].filter(([, n]) => n > 0);
    const total = parts.reduce((a, [, n]) => a + n, 0);
    if (!total) return;
    if (parts.length === 1) {
      el('circle', { r, class: 'seg seg-' + parts[0][0], 'stroke-width': width }, g);
      return;
    }
    const gap = deg(5);
    let a = -Math.PI / 2;
    const span = TAU - gap * parts.length;
    for (const [kind, n] of parts) {
      const sweep = (span * n) / total;
      el(
        'path',
        {
          d: arcD(r, a + gap / 2, a + gap / 2 + Math.max(sweep, 0.0001)),
          class: 'seg seg-' + kind,
          'stroke-width': width,
        },
        g,
      );
      a += sweep + gap;
    }
  }

  let worldEdges = [];
  function renderWorld() {
    landG.textContent = edgeG.textContent = nodeG.textContent = '';
    const nodes = worldNodes();
    const chs = worldChannels();
    const rows = layoutWorld(nodes, chs);
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (const n of nodes) {
      x0 = Math.min(x0, n.x - n.r - 60);
      x1 = Math.max(x1, n.x + n.r + 60);
      y0 = Math.min(y0, n.y - n.r - 40);
      y1 = Math.max(y1, n.y + n.r + 40);
    }
    worldBox = { x0, x1, y0, y1 };
    for (let gx = Math.floor((x0 - 800) / 160) * 160; gx < x1 + 800; gx += 160)
      el('line', { x1: gx, y1: y0 - 800, x2: gx, y2: y1 + 800, class: 'grat' }, landG);
    for (let gy = Math.floor((y0 - 800) / 160) * 160; gy < y1 + 800; gy += 160)
      el('line', { x1: x0 - 800, y1: gy, x2: x1 + 800, y2: gy, class: 'grat' }, landG);
    // Land is the union of each plugin's surroundings, so close neighbours share a continent.
    for (const n of nodes) el('circle', { cx: n.x, cy: n.y, r: n.r + 78, class: 'land-b' }, landG);
    for (const n of nodes) el('circle', { cx: n.x, cy: n.y, r: n.r + 68, class: 'land-a' }, landG);
    worldEdges = [];
    const OFF = {
      call: 0,
      hook: 0.16,
      event: 0.22,
      tool: -0.22,
      table: -0.14,
      http: 0.1,
      idle: 0.08,
    };
    for (const c of chs) {
      const a = pos.get(c.from),
        b = pos.get(c.to);
      if (!a || !b) continue;
      const dx = b.x - a.x,
        dy = b.y - a.y,
        dist = Math.hypot(dx, dy) || 1;
      const nx = -dy / dist,
        ny = dx / dist,
        off = OFF[c.kind] * Math.min(dist, 400);
      const cx = (a.x + b.x) / 2 + nx * off,
        cy = (a.y + b.y) / 2 + ny * off;
      const from = towards(a, cx, cy, a.r + 5),
        to = towards(b, cx, cy, b.r + 7);
      const d = `M${from[0]} ${from[1]}Q${cx} ${cy} ${to[0]} ${to[1]}`;
      const w =
        c.kind === 'call' || c.kind === 'hook'
          ? 0.6 + Math.sqrt(c.items.length) * 0.4
          : c.kind === 'idle'
            ? 0.8
            : 0.7 + Math.sqrt(c.items.length) * 0.3;
      const g = el('g', { class: 'edge k-' + c.kind }, edgeG);
      const kcls = 'k-' + c.kind + (c.undeclared && c.kind === 'call' ? ' undeclared' : '');
      el('path', { d, class: 'base ' + kcls, 'stroke-width': w }, g);
      el('path', { d, class: 'flow ' + kcls, 'stroke-width': w + 2 }, g);
      g.addEventListener('mouseenter', () => !pinned && showCard(channelCard(c)));
      g.addEventListener('mouseleave', () => !pinned && hideCard());
      g.addEventListener('click', (ev) => {
        ev.stopPropagation();
        pinCard(channelCard(c));
      });
      worldEdges.push({ g, c });
    }
    for (const n of nodes) {
      const g = el(
        'g',
        {
          class: 'node ' + n.realm,
          transform: `translate(${n.x} ${n.y})`,
          tabindex: 0,
          role: 'button',
          'aria-label': label(n.id),
        },
        nodeG,
      );
      g.__id = n.id;
      el('circle', { r: n.r, class: 'core' }, g);
      if (n.realm === 'machine') el('circle', { r: n.r + 2.5, class: 'core2' }, g);
      if (n.p) ringSegments(g, n.p, n.r + 4, 2);
      if (n.id === RESEARCH)
        n.members.forEach((id, i) => {
          const [x, y] = polar(n.r * 0.55, (i / n.members.length) * TAU - Math.PI / 2);
          el('circle', { cx: x, cy: y, r: 2.5, class: 'dotlet' }, g);
        });
      const reach = channels.some(
        (c) => c.kind === 'table' && mapId(c.from) === n.id && c.items.some((t) => t.runtime > 0),
      );
      const undeclared = channels.some(
        (c) => c.kind === 'call' && c.declared === null && mapId(c.from) === n.id,
      );
      if (reach) el('circle', { cx: n.r + 7, cy: -n.r - 3, r: 2.6, class: 'badge-table' }, g);
      if (undeclared) el('circle', { cx: -n.r - 7, cy: -n.r - 3, r: 2.6, class: 'badge-warn' }, g);
      const t = el('text', { y: n.r + 22, class: 'name' }, g);
      t.textContent = label(n.id);
      g.addEventListener('mouseenter', () => {
        light(n.id);
        if (!pinned) showCard(pluginCard(n));
      });
      g.addEventListener('mouseleave', () => {
        unlight();
        if (!pinned) hideCard();
      });
      g.addEventListener('focus', () => light(n.id));
      g.addEventListener('blur', unlight);
      g.addEventListener('click', (ev) => {
        ev.stopPropagation();
        dive(n.id);
      });
      g.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') dive(n.id);
      });
    }
    buildLegend();
  }
  function towards(a, x, y, r) {
    const dx = x - a.x,
      dy = y - a.y,
      d = Math.hypot(dx, dy) || 1;
    return [+(a.x + (dx / d) * r).toFixed(1), +(a.y + (dy / d) * r).toFixed(1)];
  }
  function light(id) {
    if (focus) return;
    svg.classList.add('lighting');
    const near = new Set([id]);
    for (const { g, c } of worldEdges) {
      const on = c.from === id || c.to === id;
      g.classList.toggle('lit', on);
      if (on) {
        near.add(c.from);
        near.add(c.to);
      }
    }
    nodeG.querySelectorAll('.node').forEach((g) => g.classList.toggle('lit', near.has(g.__id)));
  }
  function unlight() {
    svg.classList.remove('lighting');
    worldEdges.forEach(({ g }) => g.classList.remove('lit'));
    nodeG.querySelectorAll('.node').forEach((g) => g.classList.remove('lit'));
  }

  /* ---------------- dive ---------------- */
  function dive(id) {
    if (id === RESEARCH) {
      showResearch = true;
      rerender();
      return;
    }
    if ((P.get(id) || {}).realm === 'research' && !showResearch) {
      showResearch = true;
      rerender();
    }
    const at = pos.get(id);
    if (!at) return;
    unlight();
    hideCard(true);
    sceneG.textContent = '';
    const p = P.get(id);
    const s = (at.r * 2.6) / SCENE.R;
    const g = el(
      'g',
      { class: 'scene', transform: `translate(${at.x} ${at.y}) scale(${s})` },
      sceneG,
    );
    const ext = buildScene(g, p);
    svg.classList.add('diving');
    focus = { id, k: 1 };
    renderGuide();
    const left = panelWidth();
    const k = Math.min(
      (W - left - 40) / ((ext.x1 - ext.x0) * s),
      (H - 110) / ((ext.y1 - ext.y0) * s),
    );
    const to = {
      x: at.x + ((ext.x0 + ext.x1) / 2) * s - left / 2 / k,
      y: at.y + ((ext.y0 + ext.y1) / 2) * s + 20 / k,
      k,
    };
    focus.k = k;
    fly(to, 850);
    renderCrumbs();
    if (location.hash.slice(1) !== id) history.replaceState(null, '', '#' + id);
  }
  function surfaceOut() {
    if (!focus) return;
    focus = null;
    hideCard(true);
    svg.classList.remove('diving');
    fly(fitTo(worldBox), 750, () => {
      if (!focus) sceneG.textContent = '';
    });
    renderCrumbs();
    history.replaceState(null, '', location.pathname + location.search);
  }
  function rerender() {
    renderWorld();
    if (!focus) fly(fitTo(worldBox), 600);
    renderToolbar();
  }

  /* ---------------- the scene: one plugin, its contract and its neighbours ---------------- */
  const SCENE = { R: 300, RN: 720 };
  function buildScene(g, p) {
    const { R, RN } = SCENE;
    const id = p.id;
    const lines = el('g', {}, g),
      coreG = el('g', {}, g),
      portG = el('g', {}, g),
      nbrG = el('g', {}, g),
      smG = el('g', {}, g);

    // neighbours and how they relate
    const rel = new Map();
    const relOf = (n) => {
      if (!rel.has(n)) rel.set(n, { id: n, inn: [], out: [], dependsOnUs: false, weDepend: false });
      return rel.get(n);
    };
    for (const c of channels) {
      if (c.kind === 'hook') continue;
      if (c.from === id && c.to !== id) {
        const r = relOf(c.to);
        r.out.push(c);
        if (c.kind === 'event') r.dependsOnUs = true;
        else r.weDepend = true;
      } else if (c.to === id && c.from !== id) {
        const r = relOf(c.from);
        r.inn.push(c);
        if (c.kind === 'event') r.weDepend = true;
        else r.dependsOnUs = true;
      }
    }
    if (p.tools.length)
      rel.set('@agents', {
        id: '@agents',
        inn: [],
        out: [],
        dependsOnUs: true,
        weDepend: false,
        agents: true,
      });
    const nbrs = [...rel.values()].sort((a, b) => label(a.id).localeCompare(label(b.id)));
    const groups = { right: [], left: [], top: [] };
    for (const n of nbrs)
      (n.agents
        ? groups.top
        : n.dependsOnUs && n.weDepend
          ? groups.top
          : n.weDepend
            ? groups.right
            : groups.left
      ).push(n);
    const total = nbrs.length || 1;
    const step = Math.min(deg(26), deg(340) / total);
    const spans = {
      right: groups.right.length * step,
      left: groups.left.length * step,
      top: groups.top.length * step,
    };
    let r0 = -spans.right / 2,
      r1 = r0 + spans.right;
    let l0 = Math.max(r1 + deg(8), Math.PI - spans.left / 2),
      l1 = l0 + spans.left;
    let t0 = Math.max(l1 + deg(8), deg(270) - spans.top / 2),
      t1 = t0 + spans.top;
    if (t1 > TAU + r0 - deg(6)) {
      t0 = l1 + deg(4);
      t1 = t0 + spans.top;
    }
    const assign = (list, a0) =>
      list.forEach((n, i) => {
        n.a = a0 + step * (i + 0.5);
      });
    assign(groups.right, r0);
    assign(groups.left, l0);
    assign(groups.top, t0);
    const captions = [
      [groups.left.filter((n) => !n.agents), 'Uses ' + p.label],
      [groups.right, p.label + ' uses'],
      [groups.top.filter((n) => !n.agents), 'Both ways'],
    ];
    for (const n of nbrs) {
      const q = P.get(n.id);
      n.r = n.agents ? 22 : 9 + Math.sqrt(q ? q.loc : 400) * 0.16;
      [n.x, n.y] = polar(RN, n.a);
    }
    const nbrById = new Map(nbrs.map((n) => [n.id, n]));

    // ports: the contract surface around the wall
    const ports = [];
    for (const svc of p.services)
      for (const m of svc.members)
        ports.push({
          kind: m.hook ? 'hook' : m.kind === 'value' ? 'value' : 'method',
          svc: svc.key,
          name: m.name,
          member: m,
          callers: [],
        });
    for (const t of p.tools) ports.push({ kind: 'tool', name: t.name, tool: t, callers: [] });
    for (const e of p.emits) ports.push({ kind: 'eout', name: e, callers: [] });
    for (const e of p.consumes) ports.push({ kind: 'ein', name: e, callers: [] });
    const portBy = new Map(
      ports.map((pt) => [pt.kind + ':' + (pt.svc ? pt.svc + '.' : '') + pt.name, pt]),
    );
    const methodPort = (svc, name) =>
      portBy.get('method:' + svc + '.' + name) ||
      portBy.get('hook:' + svc + '.' + name) ||
      portBy.get('value:' + svc + '.' + name);
    for (const n of nbrs) {
      for (const c of n.inn) {
        if (c.kind === 'call')
          for (const it of c.items) {
            const pt = methodPort(it.svc, it.name);
            if (pt) pt.callers.push({ n, it, c });
          }
        if (c.kind === 'tool')
          for (const it of c.items) {
            const pt = portBy.get('tool:' + it.name);
            if (pt) pt.callers.push({ n, it, c });
          }
        if (c.kind === 'event')
          for (const it of c.items) {
            const pt = portBy.get('ein:' + it.name);
            if (pt) pt.callers.push({ n, it, c });
          }
      }
      for (const c of n.out)
        if (c.kind === 'event')
          for (const it of c.items) {
            const pt = portBy.get('eout:' + it.name);
            if (pt) pt.callers.push({ n, it, c });
          }
      if (n.agents)
        for (const pt of ports)
          if (pt.kind === 'tool')
            pt.callers.push({ n, it: { name: pt.name }, c: { kind: 'tool' } });
    }
    for (const pt of ports) {
      const pref = cmean(pt.callers.map((x) => x.n.a));
      pt.pref = pref === null ? deg(90) : pref;
    }
    ports.sort((a, b) => norm(a.pref) - norm(b.pref) || a.name.localeCompare(b.name));
    const pstep = TAU / Math.max(ports.length, 1);
    let best = 0,
      bestCost = Infinity;
    for (let o = 0; o < 360; o += 1) {
      let cost = 0;
      ports.forEach((pt, i) => {
        const d = adiff(deg(o) + i * pstep, pt.pref);
        cost += d * d * (pt.callers.length ? 1 : 0.2);
      });
      if (cost < bestCost) {
        bestCost = cost;
        best = deg(o);
      }
    }
    ports.forEach((pt, i) => {
      pt.a = best + i * pstep;
      [pt.x, pt.y] = polar(R, pt.a);
    });

    // core: wall, services, files, tables
    el('circle', { r: R, class: 'wall' }, coreG);
    el('circle', { r: R - 58, class: 'wall-ring' }, coreG);
    const svcColor = ['var(--call)', 'var(--tool)', 'var(--event)', 'var(--hook)'];
    if (p.services.length > 1)
      p.services.forEach((svc, si) => {
        const own = ports.filter((pt) => pt.svc === svc.key);
        for (const pt of own)
          el(
            'path',
            {
              d: arcD(R + 6, pt.a - pstep / 2, pt.a + pstep / 2),
              class: 'svc-arc',
              stroke: svcColor[si % svcColor.length],
            },
            coreG,
          );
      });
    const tableFiles = new Set(p.tables.map((t) => t.file));
    const toolFiles = new Set(p.tools.map((t) => t.file));
    const packed = pack(p.files, R - 78);
    const fileEls = [];
    packed.forEach((f, i) => {
      const cls =
        'file' +
        (toolFiles.has(f.path)
          ? ' f-tool'
          : tableFiles.has(f.path)
            ? ' f-table'
            : f.path.startsWith('web/')
              ? ' f-web'
              : '');
      const c = el('circle', { cx: f.x, cy: f.y, r: f.r, class: cls }, coreG);
      fileEls[i] = c;
      c.addEventListener('mouseenter', () => {
        if (!pinned) showCard(fileCard(p, f));
        c.classList.add('lit');
        impG.querySelectorAll('[data-f="' + i + '"]').forEach((l) => l.classList.add('lit'));
      });
      c.addEventListener('mouseleave', () => {
        if (!pinned) hideCard();
        c.classList.remove('lit');
        impG.querySelectorAll('.lit').forEach((l) => l.classList.remove('lit'));
      });
    });
    const impG = el('g', {}, coreG);
    packed.forEach((f, i) =>
      f.imports.forEach((j) => {
        const t = packed[j];
        if (t) el('line', { x1: f.x, y1: f.y, x2: t.x, y2: t.y, class: 'imp', 'data-f': i }, impG);
      }),
    );

    const readers = new Map();
    for (const n of nbrs)
      for (const c of n.inn)
        if (c.kind === 'table')
          for (const it of c.items)
            (readers.get(it.name) || readers.set(it.name, []).get(it.name)).push({ n, it });
    const tbls = p.tables.map((t) => ({
      ...t,
      pref: cmean((readers.get(t.name) || []).map((x) => x.n.a)),
    }));
    const tstep = Math.min(deg(9), TAU / Math.max(tbls.length, 1));
    const tUsed = tbls.filter((t) => t.pref !== null).sort((a, b) => norm(a.pref) - norm(b.pref));
    const tIdle = tbls.filter((t) => t.pref === null);
    const tAll = [...tUsed, ...tIdle];
    const tCenter = tUsed.length ? cmean(tUsed.map((t) => t.pref)) : deg(90);
    tAll.forEach((t, i) => {
      t.a = tCenter + (i - (tAll.length - 1) / 2) * tstep;
      [t.x, t.y] = polar(R - 30, t.a);
    });
    const tableBy = new Map(tAll.map((t) => [t.name, t]));
    for (const t of tAll) {
      const cg = el('g', { transform: `translate(${t.x} ${t.y})` }, coreG);
      cylinder(cg, 0, 0, 1);
      cg.addEventListener(
        'mouseenter',
        () => !pinned && showCard(tableCard(p, t, readers.get(t.name) || [])),
      );
      cg.addEventListener('mouseleave', () => !pinned && hideCard());
    }

    // wires
    const wires = [];
    const wire = (d, kind, w, owners, opts = {}) => {
      const gg = el('g', { class: 'wire' }, lines);
      const kc = 'k-' + kind + (opts.warn ? ' undeclared' : '');
      el('path', { d, class: 'edge base ' + kc, 'stroke-width': w * 0.6 + 0.5 }, gg);
      if (kind !== 'idle')
        el('path', { d, class: 'edge flow ' + kc, 'stroke-width': w * 0.6 + 3 }, gg);
      wires.push({ g: gg, owners });
      return gg;
    };
    const curveToPort = (n, pt, reverse) => {
      const [cx, cy] = polar(R + 150, pt.a);
      const s = towards(n, cx, cy, n.r + 4);
      const e = polar(R + 8, pt.a);
      return reverse
        ? `M${e[0]} ${e[1]}Q${cx} ${cy} ${s[0]} ${s[1]}`
        : `M${s[0]} ${s[1]}Q${cx} ${cy} ${e[0]} ${e[1]}`;
    };
    const coreToNbr = (n, reverse) => {
      const a = polar(R + 6, n.a);
      const b = towards(n, a[0], a[1], n.r + 4);
      return reverse ? `M${b[0]} ${b[1]}L${a[0]} ${a[1]}` : `M${a[0]} ${a[1]}L${b[0]} ${b[1]}`;
    };
    for (const pt of ports)
      for (const x of pt.callers) {
        const kind =
          pt.kind === 'tool'
            ? 'tool'
            : pt.kind === 'eout' || pt.kind === 'ein'
              ? 'event'
              : pt.kind === 'hook'
                ? 'hook'
                : 'call';
        const w = 0.8 + Math.log2(1 + (x.it.count || 1)) * 0.9;
        const reverse = pt.kind === 'eout' || pt.kind === 'hook';
        wire(curveToPort(x.n, pt, reverse), kind, w, [x.n.id, 'port:' + ports.indexOf(pt)], {
          warn: x.c.declared === null && kind === 'call',
        });
      }
    for (const n of nbrs) {
      for (const c of n.inn) {
        if (c.kind === 'table')
          for (const it of c.items) {
            const t = tableBy.get(it.name);
            if (!t) continue;
            const s = towards(n, t.x, t.y, n.r + 4);
            wire(`M${s[0]} ${s[1]}L${t.x} ${t.y}`, 'table', 1.2, [n.id, 'table:' + it.name]);
          }
        if (c.kind === 'http') wire(coreToNbr(n, true), 'http', 3, [n.id]);
        if (c.kind === 'idle') wire(coreToNbr(n, true), 'idle', 1.2, [n.id]);
      }
      for (const c of n.out) {
        if (c.kind === 'call') {
          const hooks = c.items.filter((i) => i.hook);
          wire(coreToNbr(n, false), 'call', 1 + Math.sqrt(c.items.length) * 1.1, [n.id], {
            warn: c.declared === null,
          });
          if (hooks.length) wire(coreToNbr(n, true), 'hook', 1 + Math.sqrt(hooks.length), [n.id]);
        }
        if (c.kind === 'idle') wire(coreToNbr(n, false), 'idle', 1.2, [n.id]);
        if (c.kind === 'tool')
          wire(coreToNbr(n, false), 'tool', 1.2 + Math.sqrt(c.items.length), [n.id]);
        if (c.kind === 'table')
          wire(coreToNbr(n, false), 'table', 1.2 + Math.sqrt(c.items.length), [n.id]);
        if (c.kind === 'http') wire(coreToNbr(n, false), 'http', 3, [n.id]);
      }
    }

    // ports and their names
    ports.forEach((pt, i) => {
      const pg = el(
        'g',
        {
          class: 'port' + (pt.callers.length ? '' : ' unused'),
          transform: `translate(${pt.x} ${pt.y}) rotate(${(pt.a * 180) / Math.PI})`,
        },
        portG,
      );
      const size = 3.5 + Math.sqrt(pt.callers.length) * 1.7;
      if (pt.kind === 'method') el('circle', { r: size, class: 'p-method' }, pg);
      else if (pt.kind === 'value')
        el('rect', { x: -4, y: -4, width: 8, height: 8, class: 'p-value' }, pg);
      else if (pt.kind === 'hook') el('circle', { r: size + 1, class: 'p-hook' }, pg);
      else if (pt.kind === 'tool')
        el(
          'path',
          {
            d: `M${-size - 2} 0L0 ${-size - 2}L${size + 2} 0L0 ${size + 2}Z`,
            class: 'p-tool' + (pt.tool.readOnly ? ' ro' : ''),
          },
          pg,
        );
      else if (pt.kind === 'eout')
        el('path', { d: `M${-6} ${-8}L${10} 0L${-6} 8Z`, class: 'p-eout' }, pg);
      else el('path', { d: `M${10} ${-8}L${-6} 0L${10} 8Z`, class: 'p-ein' }, pg);
      const flip = Math.cos(pt.a) < 0;
      const t = el(
        'text',
        {
          class:
            'plabel' +
            (pt.callers.length ? '' : ' unused') +
            (pt.kind === 'tool'
              ? ' k-tool'
              : pt.kind === 'eout' || pt.kind === 'ein'
                ? ' k-event'
                : pt.kind === 'hook'
                  ? ' k-hook'
                  : ''),
          x: flip ? -18 : 18,
          y: 5,
          'text-anchor': flip ? 'end' : 'start',
          transform: flip ? 'rotate(180)' : null,
        },
        pg,
      );
      t.textContent = pt.name;
      pg.__owners = ['port:' + i];
      pg.addEventListener('mouseenter', () => {
        sceneLight(
          g,
          wires,
          'port:' + i,
          pt.callers.map((x) => x.n.id),
          pg,
        );
        if (!pinned) showCard(portCard(p, pt));
      });
      pg.addEventListener('mouseleave', () => {
        sceneUnlight(g);
        if (!pinned) hideCard();
      });
      pg.addEventListener('click', (ev) => {
        ev.stopPropagation();
        pinCard(portCard(p, pt));
      });
    });

    // neighbours
    for (const n of nbrs) {
      const q = P.get(n.id);
      const ng = el(
        'g',
        {
          class: 'nbr' + (n.agents ? ' agents' : q && q.realm === 'research' ? ' research' : ''),
          transform: `translate(${n.x} ${n.y})`,
          tabindex: 0,
          role: 'button',
          'aria-label': label(n.id),
        },
        nbrG,
      );
      ng.__nid = n.id;
      el('circle', { r: n.r, class: 'core' }, ng);
      if (n.agents) {
        const ig = el(
          'g',
          {
            transform: 'translate(-16 -16) scale(1.33)',
            fill: 'none',
            stroke: 'var(--tool)',
            'stroke-width': 2,
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
          },
          ng,
        );
        ig.innerHTML = ICON.agent;
      }
      if (q) ringSegments(ng, q, n.r + 4, 1.6);
      const right = Math.cos(n.a) >= 0;
      const t = el(
        'text',
        {
          class: 'name',
          x: right === null ? 0 : right ? n.r + 10 : -n.r - 10,
          y: right === null ? (Math.sin(n.a) > 0 ? n.r + 26 : -n.r - 14) : 6,
          'text-anchor': right === null ? 'middle' : right ? 'start' : 'end',
        },
        ng,
      );
      t.textContent = label(n.id);
      // methods of theirs that we call, as small dots facing us
      const theirs = n.out.filter((c) => c.kind === 'call').flatMap((c) => c.items);
      const fan = Math.min(deg(150), theirs.length * deg(14));
      theirs.forEach((it, i) => {
        const a =
          n.a + Math.PI + (theirs.length > 1 ? -fan / 2 + (fan * i) / (theirs.length - 1) : 0);
        const [x, y] = polar(n.r + 10, a);
        const d = el(
          'circle',
          { cx: x, cy: y, r: it.hook ? 3 : 2.6, class: 'mdot' + (it.hook ? ' hook' : '') },
          ng,
        );
        const m = members.get(it.svc + '.' + it.name);
        d.addEventListener('mouseenter', (ev) => {
          ev.stopPropagation();
          if (!pinned && m) showCard(memberCard(m, [{ n: { id }, it }]));
        });
        d.addEventListener('mouseleave', () => {
          if (!pinned) hideCard();
        });
      });
      n.out
        .filter((c) => c.kind === 'table')
        .forEach((c, i) => cylinder(ng, (i - 0.5) * 14, -n.r - 18, 0.6, 'mcyl'));
      ng.addEventListener('mouseenter', () => {
        sceneLight(g, wires, n.id, [n.id], ng);
        if (!pinned) showCard(n.agents ? agentsCard(p) : relationCard(p, n));
      });
      ng.addEventListener('mouseleave', () => {
        sceneUnlight(g);
        if (!pinned) hideCard();
      });
      if (!n.agents) {
        ng.addEventListener('click', (ev) => {
          ev.stopPropagation();
          dive(n.id);
        });
        ng.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') dive(n.id);
        });
      }
      if (id === machineHost && machinesOf(n.id).length) {
        const right2 = Math.cos(n.a) >= 0;
        const lw = label(n.id).length * 10 + 30;
        let yy = n.y + 30;
        for (const m of machinesOf(n.id)) {
          const mg = machine(smG, m);
          const bx = right2 ? n.x + n.r + lw : n.x - n.r - lw - mg.w;
          mg.g.setAttribute('transform', `translate(${bx} ${yy - mg.h / 2})`);
          yy += mg.h + 12;
        }
      }
    }
    // what each ring of neighbours means
    for (const [list, text] of captions) {
      if (!list.length) continue;
      const a = cmean(list.map((n) => n.a));
      const [x, y] = polar(RN + 30, a);
      const out = polar(RN + Math.max(...list.map((n) => n.r)) + 150, a);
      const t = el(
        'text',
        {
          x: Math.abs(Math.cos(a)) > 0.3 ? out[0] : x,
          y: Math.abs(Math.cos(a)) > 0.3 ? out[1] : y + (Math.sin(a) < 0 ? -95 : 95),
          class: 'caption',
          'text-anchor':
            Math.abs(Math.cos(a)) > 0.3 ? (Math.cos(a) > 0 ? 'start' : 'end') : 'middle',
        },
        nbrG,
      );
      t.textContent = text;
    }
    const fileCaption = el(
      'text',
      { x: 0, y: R - 50, class: 'caption small', 'text-anchor': 'middle' },
      coreG,
    );
    fileCaption.textContent = plural(p.files.length, 'file');
    if (tAll.length) {
      const [tx, ty] = polar(R - 70, tCenter);
      const tc = el(
        'text',
        { x: tx, y: ty + 6, class: 'caption small table', 'text-anchor': 'middle' },
        coreG,
      );
      tc.textContent = plural(tAll.length, 'table');
    }
    // a program's own machines sit below its plugin
    const own = machinesOf(id);
    if (own.length) {
      let x = 0;
      const made = own.map((m) => machine(smG, m));
      const totalW = made.reduce((a, m) => a + m.w + 30, -30);
      x = -totalW / 2;
      for (const m of made) {
        m.g.setAttribute('transform', `translate(${x} ${RN + 120})`);
        x += m.w + 30;
      }
    }

    g.addEventListener('click', () => {
      if (pinned) unpin();
    });
    const b = g.getBBox();
    return { x0: b.x - 20, x1: b.x + b.width + 20, y0: b.y - 20, y1: b.y + b.height + 20 };
  }

  function sceneLight(scene, wires, key, nbrIds, self) {
    scene.classList.add('lighting');
    for (const w of wires) w.g.classList.toggle('lit', w.owners.includes(key));
    scene
      .querySelectorAll('.nbr')
      .forEach((n) => n.classList.toggle('lit', nbrIds.includes(n.__nid) || n === self));
    scene
      .querySelectorAll('.port')
      .forEach((pg) =>
        pg.classList.toggle(
          'lit',
          pg === self ||
            (key &&
              !key.startsWith('port:') &&
              wires.some((w) => w.owners.includes(key) && w.owners.includes(pg.__owners[0]))),
        ),
      );
    scene
      .querySelectorAll('.plabel')
      .forEach((t) => t.classList.toggle('lit', t.parentNode.classList.contains('lit')));
  }
  function sceneUnlight(scene) {
    scene.classList.remove('lighting');
    scene.querySelectorAll('.lit').forEach((e) => e.classList.remove('lit'));
  }

  function cylinder(g, x, y, s, cls) {
    const w = 9 * s,
      h = 12 * s,
      ry = 3 * s;
    el(
      'path',
      {
        d: `M${x - w} ${y - h / 2}v${h}a${w} ${ry} 0 0 0 ${2 * w} 0v${-h}a${w} ${ry} 0 0 0 ${-2 * w} 0a${w} ${ry} 0 0 0 ${2 * w} 0`,
        class: cls || 'cyl',
      },
      g,
    );
  }

  /* files packed inside the wall, biggest at the middle */
  function pack(files, radiusMax) {
    const total = files.reduce((n, f) => n + f.loc, 0) || 1;
    let k = Math.sqrt((0.5 * radiusMax * radiusMax) / total);
    for (let attempt = 0; attempt < 12; attempt++) {
      const out = [];
      const order = files
        .map((f, i) => ({ ...f, i, r: Math.max(3, k * Math.sqrt(f.loc)) }))
        .sort((a, b) => b.r - a.r);
      let ok = true;
      for (const f of order) {
        let placed = false;
        for (let t = 0; t < 6000 && !placed; t++) {
          const a = t * 0.31,
            d = Math.sqrt(t) * 3.2;
          const x = Math.cos(a) * d,
            y = Math.sin(a) * d;
          if (d + f.r > radiusMax) continue;
          if (out.every((o) => Math.hypot(o.x - x, o.y - y) >= o.r + f.r + 2)) {
            f.x = x;
            f.y = y;
            out.push(f);
            placed = true;
          }
        }
        if (!placed) {
          ok = false;
          break;
        }
      }
      if (ok) {
        const res = [];
        for (const f of out) res[f.i] = f;
        return res;
      }
      k *= 0.88;
    }
    return files.map((f) => ({ ...f, x: 0, y: 0, r: 2 }));
  }

  /* a state machine as a strip: forward edges above, returns below */
  function machine(parent, m) {
    const order = [m.initial];
    const forward = new Map();
    for (const e of m.edges)
      (forward.get(e.from) || forward.set(e.from, []).get(e.from)).push(e.to);
    for (let i = 0; i < order.length; i++)
      for (const t of forward.get(order[i]) || [])
        if (!order.includes(t) && !m.terminal.includes(t)) order.push(t);
    for (const s of m.states) if (!order.includes(s) && !m.terminal.includes(s)) order.push(s);
    for (const s of m.terminal) if (!order.includes(s)) order.push(s);
    const gap = 34,
      pad = 16;
    const x = (s) => pad + order.indexOf(s) * gap;
    const w = pad * 2 + (order.length - 1) * gap,
      h = 70;
    const g = el(
      'g',
      { class: 'sm', tabindex: 0, role: 'img', 'aria-label': `${m.name} state machine` },
      parent,
    );
    const wrap = el('g', { class: 'sm-wrap' }, g);
    el('rect', { x: 0, y: 0, width: w, height: h, rx: 8, class: 'sm-bg' }, wrap);
    const cy = 38;
    const tname = el('text', { x: 8, y: 12, class: 'smt' }, wrap);
    tname.textContent =
      m.name +
      (m.exportName && !/^[A-Z_]+$/.test(m.exportName) && m.exportName !== 'definition'
        ? ' · ' + m.exportName
        : '');
    const seen = new Set();
    for (const e of m.edges) {
      const key = e.from + '>' + e.to;
      if (seen.has(key)) continue;
      seen.add(key);
      const a = x(e.from),
        b = x(e.to);
      if (e.from === e.to) {
        el('path', { d: `M${a - 4} ${cy - 6}c-6 -14 14 -14 8 0`, class: 'tr' }, wrap);
        continue;
      }
      const span = Math.abs(b - a);
      const back = b < a;
      const lift = span <= gap ? 0 : Math.min(26, 6 + span * 0.12);
      const dy = back ? 6 + Math.min(20, span * 0.1) : -lift;
      el(
        'path',
        {
          d: `M${a} ${cy + (back ? 5 : lift ? -5 : 0)}Q${(a + b) / 2} ${cy + dy * 1.8} ${b} ${cy + (back ? 5 : lift ? -5 : 0)}`,
          class: 'tr' + (back ? ' back' : ''),
        },
        wrap,
      );
    }
    for (const s of order) {
      const term = m.terminal.includes(s);
      if (term) el('circle', { cx: x(s), cy, r: 8, class: 'st term' }, wrap);
      el(
        'circle',
        { cx: x(s), cy, r: term ? 5 : 6, class: 'st' + (s === m.initial ? ' init' : '') },
        wrap,
      );
      const t = el(
        'text',
        {
          x: x(s) + 3,
          y: cy + 14,
          class: 'stl',
          'text-anchor': 'end',
          transform: `rotate(-40 ${x(s) + 3} ${cy + 14})`,
        },
        wrap,
      );
      t.textContent = s;
    }
    g.addEventListener('mouseenter', () => {
      g.classList.add('grown');
      g.parentNode.appendChild(g);
      if (!pinned) showCard(machineCard(m));
    });
    g.addEventListener('mouseleave', () => {
      g.classList.remove('grown');
      if (!pinned) hideCard();
    });
    return { g, w, h };
  }

  /* ---------------- cards: text only where it decides something ---------------- */
  function showCard(htmlText) {
    card.innerHTML = htmlText;
    card.hidden = false;
  }
  function hideCard(force) {
    if (pinned && !force) return;
    if (force) unpin();
    card.hidden = true;
  }
  function pinCard(htmlText) {
    pinned = true;
    card.classList.add('pinned');
    showCard(htmlText);
  }
  function unpin() {
    pinned = false;
    card.classList.remove('pinned');
    card.hidden = true;
  }
  const dotFor = (id) =>
    `<i style="background:${(P.get(id) || {}).realm === 'research' ? 'var(--muted)' : 'var(--call)'}"></i>`;
  const count = (name, n, color) =>
    n ? `<span class="ico" title="${name}">${icon(name, color)}${n}</span>` : '';
  function pluginCard(n) {
    if (!n.p)
      return `<div class="head">${icon('flask')}Research</div><div class="row">${n.members.map((id) => `<span class="chip">${dotFor(id)}${esc(label(id))}</span>`).join('')}</div>`;
    return `<div class="head">${esc(n.p.label)}</div>${n.p.purpose ? `<div class="purpose">${esc(n.p.purpose)}</div>` : ''}
      <div class="row">${surfaceWords(n.p)}</div><div class="hint">Click to open it.</div>`;
  }
  function surfaceWords(p) {
    const s = surface(p);
    return (
      [
        [s.method, 'method', 'methods', 'var(--call)', 'method'],
        [s.hook, 'hook', 'hooks', 'var(--hook)', 'hook'],
        [s.tool, 'agent tool', 'agent tools', 'var(--tool)', 'tool'],
        [s.event, 'event', 'events', 'var(--event)', 'event'],
        [s.table, 'table', 'tables', 'var(--table)', 'table'],
        [p.files.length, 'file', 'files', '', 'file'],
      ]
        .filter(([n]) => n)
        .map(
          ([n, one, many, color, ic]) =>
            `<span class="ico">${icon(ic, color)}${plural(n, one, many)}</span>`,
        )
        .join('') + `<span class="ico">${plural(p.loc, 'line')}</span>`
    );
  }
  function channelCard(c) {
    const kind = KINDS.find((k) => k[0] === c.kind);
    const what =
      c.kind === 'call' || c.kind === 'hook'
        ? 'Methods'
        : c.kind === 'table'
          ? 'Tables'
          : c.kind === 'tool'
            ? 'Tools'
            : c.kind === 'event'
              ? 'Events'
              : '';
    const items = c.items
      .slice(0, 40)
      .map(
        (i) =>
          `<span class="chip">${esc(i.svc ? i.svc + '.' + i.name : i.name)}${i.count > 1 ? ' ×' + i.count : ''}</span>`,
      )
      .join('');
    return `<div class="head"><span style="color:${kind[2]}">●</span>${esc(kind[3])}</div><div class="purpose">${sentence(c)}</div>${what && c.items.length ? `<div class="label">${what}</div><div class="row">${items}${c.items.length > 40 ? '…' : ''}</div>` : ''}${c.undeclared ? `<div class="warn">⚠ ${esc(label(c.from))} uses ${esc(label(c.to))} without declaring it as a dependency.</div>` : ''}`;
  }
  function memberCard(m, callers) {
    const params = m.params
      .map((x) => `${esc(x.name)}${x.optional ? '?' : ''}<span class="ty">: ${esc(x.type)}</span>`)
      .join(', ');
    const sig =
      m.kind === 'value'
        ? `<b>${esc(m.service)}.${esc(m.name)}</b><span class="ty">: ${esc(m.returns)}</span>`
        : `<b>${esc(m.service)}.${esc(m.name)}</b>(${params}) <span class="ty">→ ${esc(m.returns)}</span>`;
    const badges = [
      m.hook
        ? `<span class="ico">${icon('hook', 'var(--hook)')}Hook: callers plug in here</span>`
        : '',
      m.tx
        ? `<span class="ico">${icon('lock')}${m.tx === 'required' ? 'Must run inside a transaction' : 'Can join a transaction'}</span>`
        : '',
      m.caller ? `<span class="ico">${icon('shield')}Checks the caller’s permissions</span>` : '',
    ].join('');
    const who = callers
      .map(
        (x) =>
          `<span class="chip" title="${esc((x.it.sites || []).join('\n'))}">${dotFor(x.n.id)}${esc(label(x.n.id))}${x.it.count > 1 ? ' ×' + x.it.count : ''}</span>`,
      )
      .join('');
    const users = [...new Set(callers.map((x) => x.n.id))];
    return `<div class="sig">${sig}</div>${m.doc ? `<div class="doc">${esc(m.doc)}</div>` : ''}<div class="row">${badges}</div><div class="label">${users.length ? `Called by ${plural(users.length, 'plugin')}` : 'No other plugin calls this'}</div>${who ? `<div class="row">${who}</div>` : ''}`;
  }
  function portCard(p, pt) {
    if (pt.member) return memberCard({ ...pt.member, service: pt.svc }, pt.callers);
    const who = pt.callers
      .map((x) => `<span class="chip">${dotFor(x.n.id)}${esc(label(x.n.id))}</span>`)
      .join('');
    if (pt.kind === 'tool')
      return `<div class="sig">${icon('tool', 'var(--tool)')} <b>${esc(pt.name)}</b></div><div class="purpose">An agent tool${pt.tool.readOnly ? ' that only reads' : ' that can change things'}.</div><div class="doc">${esc(pt.tool.description)}</div>${who ? `<div class="label">Called by</div><div class="row">${who}</div>` : ''}`;
    const users = pt.callers.map((x) => x.n.id);
    return `<div class="sig">${icon('event', 'var(--event)')} <b>${esc(pt.name)}</b></div><div class="purpose">${
      pt.kind === 'eout'
        ? users.length
          ? `${esc(p.label)} emits this event; ${nameList(users)} react${users.length === 1 ? 's' : ''} to it.`
          : `${esc(p.label)} emits this event. No plugin subscribes to it (it may be read from the event log directly).`
        : users.length
          ? `${esc(p.label)} reacts to this event from ${nameList(users)}.`
          : `${esc(p.label)} reacts to this event.`
    }</div>`;
  }
  function relationCard(p, n) {
    const q = P.get(n.id);
    const lines = [...n.inn, ...n.out].map((c) => `<li>${sentence(c)}</li>`).join('');
    return `<div class="head">${esc(label(n.id))}</div>${q && q.purpose ? `<div class="purpose">${esc(q.purpose)}</div>` : ''}<ul class="lines">${lines}</ul><div class="hint">Click to go there.</div>`;
  }
  function agentsCard(p) {
    return `<div class="head">${icon('agent', 'var(--tool)')} Agents</div><div class="purpose">Agents reach ${esc(p.label)} through ${plural(p.tools.length, 'tool')}, called over MCP through API + Tools.</div><div class="row">${p.tools.map((t) => `<span class="chip">${esc(t.name)}</span>`).join('')}</div>`;
  }
  function tableCard(p, t, readers) {
    return `<div class="sig">${icon('table', 'var(--table)')} <b>${esc(t.name)}</b></div><div class="purpose">A table ${esc(p.label)} owns, created in <code>${esc(t.file)}</code>.${readers.length ? ` ${nameList(readers.map((r) => r.n.id))} also ${readers.length === 1 ? 'queries' : 'query'} it directly, bypassing ${esc(p.label)}’s service.` : ' Only its owner queries it.'}</div>${readers.length ? `<div class="row">${readers.map((r) => `<span class="chip" title="${esc(r.it.files.join('\n'))}">${dotFor(r.n.id)}${esc(label(r.n.id))}${r.it.runtime ? '' : ' (migration only)'}</span>`).join('')}</div>` : ''}`;
  }
  function fileCard(p, f) {
    return `<div class="sig">${icon('file')} <b>${esc(f.path)}</b></div><div class="purpose">${plural(f.loc, 'line')}${f.imports.length ? `, imports ${plural(f.imports.length, 'other file')} in this plugin (lit up)` : ''}.</div>`;
  }
  // An action taken from three or more states is a common exit; show it once.
  function transitions(m) {
    const byAction = new Map();
    for (const e of m.edges) byAction.set(e.action, [...(byAction.get(e.action) || []), e]);
    const out = [];
    for (const [action, edges] of byAction) {
      const to = [...new Set(edges.map((e) => e.to))];
      if (edges.length >= 3 && to.length === 1)
        out.push(
          `<span class="chip">any active state → ${esc(to[0])} <span class="ty">${esc(action)}</span></span>`,
        );
      else
        for (const e of edges)
          out.push(
            `<span class="chip">${esc(e.from)} → ${esc(e.to)} <span class="ty">${esc(action)}</span></span>`,
          );
    }
    return out.join('');
  }
  function machineCard(m) {
    return `<div class="head">${esc(m.name)} state machine <span class="ty">v${m.version}</span></div><div class="purpose">Registered with Workflows by ${esc(label(m.owner))}: ${plural(m.states.length, 'state')}, ${plural(m.edges.length, 'transition')}. Starts at <b>${esc(m.initial)}</b>; ends at ${m.terminal.map((t) => `<b>${esc(t)}</b>`).join(', ')}. Teal arcs go backwards (rework).</div><div class="label">Transitions</div><div class="row">${transitions(m)}</div>`;
  }

  /* ---------------- guide: how to read what is on screen ---------------- */
  const guide = document.getElementById('guide');
  let guideOpen = true;
  try {
    guideOpen = localStorage.getItem('atlas-guide') !== 'closed';
  } catch {}
  const key = (shape, color, text) =>
    `<li><svg viewBox="0 0 24 24" aria-hidden="true">${shape(color)}</svg><span>${text}</span></li>`;
  const ring = (c) => `<circle cx="12" cy="12" r="7" fill="none" stroke="${c}" stroke-width="4"/>`;
  const dot = (c) => `<circle cx="12" cy="12" r="5" fill="${c}"/>`;
  const hollow = (c) =>
    `<circle cx="12" cy="12" r="5.5" fill="none" stroke="${c}" stroke-width="3"/>`;
  const diamond = (c) => `<path d="M12 5l7 7-7 7-7-7z" fill="${c}"/>`;
  const tri = (c) => `<path d="M7 6l11 6-11 6z" fill="${c}"/>`;
  const cyl = (c) =>
    `<path d="M6 7v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V7M6 7c0 1.4 2.7 2.5 6 2.5S18 8.4 18 7s-2.7-2.5-6-2.5S6 5.6 6 7" fill="none" stroke="${c}" stroke-width="2"/>`;
  function renderGuide() {
    if (!guideOpen) {
      guide.innerHTML = `<button class="btn" id="guide-open" title="How to read this">?</button>`;
      guide.querySelector('button').addEventListener('click', () => setGuide(true));
      return;
    }
    let body;
    if (!focus)
      body = `<h2>Merv’s plugins</h2>
        <p>Each circle is a plugin, sized by its code. Foundations sit at the bottom; plugins above depend on them.</p>
        <p><b>Hover</b> to see who a plugin talks to. <b>Click</b> to open it.</p>
        <ul class="key">
          ${key(dot, 'var(--call)', 'methods other plugins call')}
          ${key(dot, 'var(--hook)', 'hooks other plugins plug into')}
          ${key(dot, 'var(--tool)', 'tools for agents')}
          ${key(dot, 'var(--event)', 'events it emits')}
          ${key(dot, 'var(--table)', 'database tables it owns')}
          ${key(dot, 'var(--table)', '<b>Red dot</b>: it queries another plugin’s tables directly')}
          ${key(dot, 'var(--warn)', '<b>Amber dot</b>: it calls a service it never declared')}
        </ul>
        <p class="muted">Hatched: research logic. Dashed: shared library.</p>`;
    else {
      const p = P.get(focus.id);
      const users = new Set(),
        uses = new Set();
      for (const c of channels) {
        if (c.kind === 'hook') continue;
        if (c.to === p.id && c.from !== p.id) users.add(c.from);
        if (c.from === p.id && c.to !== p.id) uses.add(c.to);
      }
      const chips = (ids) =>
        [...ids]
          .sort((a, b) => label(a).localeCompare(label(b)))
          .map((id) => `<button class="chip go" data-go="${esc(id)}">${esc(label(id))}</button>`)
          .join('');
      body = `<h2>${esc(p.label)}</h2>${p.purpose ? `<p>${esc(p.purpose)}</p>` : ''}
        <div class="row">${surfaceWords(p)}</div>
        ${users.size ? `<div class="label">Used by</div><div class="row">${chips(users)}</div>` : ''}
        ${uses.size ? `<div class="label">Uses</div><div class="row">${chips(uses)}</div>` : ''}
        <div class="label">How to read it</div>
        <ul class="key">
          ${key(hollow, 'var(--ink)', 'The big circle is the plugin. Its wall holds everything other plugins can reach:')}
          ${key(dot, 'var(--call)', 'a method (bigger means more callers; faded means nobody else calls it)')}
          ${key(hollow, 'var(--hook)', 'a hook, where other plugins register their own logic')}
          ${key(diamond, 'var(--tool)', 'a tool agents can call (hollow: read-only)')}
          ${key(tri, 'var(--event)', 'an event it emits (pointing out) or reacts to (pointing in)')}
          ${key(cyl, 'var(--table)', 'inside: its tables; the grey circles are its files')}
        </ul>
        <p>Plugins on the <b>left</b> use it, plugins on the <b>right</b> are used by it, and those on <b>top</b> go both ways. Each line ends on the exact port it uses. Red lines reach straight into a table.</p>
        <p class="muted"><b>Hover</b> anything for details, <b>click</b> a neighbour to go there, and press <b>Esc</b> to zoom back out.</p>`;
    }
    guide.innerHTML = `<button class="close" title="Hide" aria-label="Hide guide">×</button>${body}`;
    guide.querySelector('.close').addEventListener('click', () => setGuide(false));
    guide
      .querySelectorAll('[data-go]')
      .forEach((b) => b.addEventListener('click', () => dive(b.getAttribute('data-go'))));
  }
  function setGuide(open) {
    guideOpen = open;
    try {
      localStorage.setItem('atlas-guide', open ? 'open' : 'closed');
    } catch {}
    renderGuide();
    if (focus) dive(focus.id);
    else fly(fitTo(worldBox), 400);
  }

  /* ---------------- chrome ---------------- */
  function renderCrumbs() {
    renderGuide();
    crumbs.innerHTML = '';
    const home = document.createElement('button');
    home.className = 'btn';
    home.title = 'Whole map (Esc)';
    home.innerHTML = icon('globe');
    home.addEventListener('click', surfaceOut);
    crumbs.appendChild(home);
    if (focus) {
      const b = document.createElement('span');
      b.className = 'btn';
      b.innerHTML = `<span class="crumb-dot"></span>${esc(label(focus.id))}`;
      crumbs.appendChild(b);
    }
  }
  function renderToolbar() {
    const bar = document.getElementById('toolbar');
    bar.innerHTML = '';
    const mk = (name, title, pressed, fn) => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.title = title;
      b.innerHTML = icon(name);
      if (pressed !== null) b.setAttribute('aria-pressed', String(pressed));
      b.addEventListener('click', fn);
      bar.appendChild(b);
    };
    mk('find', 'Go to plugin (/)', null, openFinder);
    mk('flask', 'Show research plugins', showResearch, () => {
      showResearch = !showResearch;
      if (focus) surfaceOut();
      rerender();
    });
    mk('eye', 'Show every channel', !svg.classList.contains('quiet'), () => {
      svg.classList.toggle('quiet');
      renderToolbar();
    });
    mk('fit', 'Fit map', null, () => (focus ? dive(focus.id) : fly(fitTo(worldBox), 500)));
  }
  function buildLegend() {
    const lg = document.getElementById('legend');
    lg.innerHTML = '';
    for (const [kind, title, color, word] of KINDS) {
      const n = channels.filter((c) => c.kind === kind).length;
      if (!n) continue;
      const b = document.createElement('button');
      b.className = 'btn' + (svg.classList.contains('hide-' + kind) ? ' off' : '');
      b.title = title;
      const dash =
        kind === 'table'
          ? 'stroke-dasharray="3 3"'
          : kind === 'idle'
            ? 'stroke-dasharray="1 4"'
            : '';
      b.innerHTML = `<svg viewBox="0 0 30 12" style="width:30px"><line x1="2" y1="6" x2="28" y2="6" stroke="${color}" stroke-width="${kind === 'http' ? 4 : 2.5}" stroke-linecap="round" ${dash}/>${kind !== 'idle' ? `<circle cx="22" cy="6" r="2.6" fill="${color}"/>` : ''}</svg>${word}<span class="n">${n}</span>`;
      b.addEventListener('click', () => {
        svg.classList.toggle('hide-' + kind);
        buildLegend();
      });
      lg.appendChild(b);
    }
  }
  function openFinder() {
    const f = document.getElementById('finder'),
      input = document.getElementById('find'),
      list = document.getElementById('plugins');
    list.innerHTML = A.plugins.map((p) => `<option value="${esc(p.label)}"></option>`).join('');
    f.hidden = false;
    input.value = '';
    input.focus();
  }
  document.getElementById('find').addEventListener('change', (ev) => {
    const p = A.plugins.find((q) => q.label.toLowerCase() === ev.target.value.toLowerCase());
    document.getElementById('finder').hidden = true;
    if (p) dive(p.id);
  });
  document.getElementById('find').addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      document.getElementById('finder').hidden = true;
    }
  });

  /* ---------------- input ---------------- */
  let drag = null;
  svg.addEventListener('pointerdown', (ev) => {
    drag = { x: ev.clientX, y: ev.clientY, cx: cam.x, cy: cam.y, moved: false };
  });
  addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x,
      dy = ev.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      svg.classList.add('dragging');
      svg.setPointerCapture && svg.setPointerCapture(ev.pointerId);
    }
    cancelAnimationFrame(anim);
    cam.x = drag.cx - dx / cam.k;
    cam.y = drag.cy - dy / cam.k;
    applyCam();
  });
  addEventListener('pointerup', () => {
    if (drag && drag.moved) svg.addEventListener('click', swallow, { capture: true, once: true });
    drag = null;
    svg.classList.remove('dragging');
  });
  const swallow = (ev) => ev.stopPropagation();
  svg.addEventListener('click', () => {
    if (pinned) unpin();
  });
  svg.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      cancelAnimationFrame(anim);
      const f = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.012 : 0.0016));
      const px = ev.clientX - W / 2,
        py = ev.clientY - H / 2;
      const wx = px / cam.k + cam.x,
        wy = py / cam.k + cam.y;
      cam.k = Math.min(400, Math.max(0.05, cam.k * f));
      cam.x = wx - px / cam.k;
      cam.y = wy - py / cam.k;
      applyCam();
      if (focus && cam.k < focus.k * 0.45) surfaceOut();
    },
    { passive: false },
  );
  addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'INPUT') return;
    if (ev.key === 'Escape') {
      if (pinned) unpin();
      else surfaceOut();
    }
    if (ev.key === '/') {
      ev.preventDefault();
      openFinder();
    }
    const pan = 60 / cam.k;
    if (ev.key === 'ArrowLeft') {
      cam.x -= pan;
      applyCam();
    }
    if (ev.key === 'ArrowRight') {
      cam.x += pan;
      applyCam();
    }
    if (ev.key === 'ArrowUp') {
      cam.y -= pan;
      applyCam();
    }
    if (ev.key === 'ArrowDown') {
      cam.y += pan;
      applyCam();
    }
    if (ev.key === '+' || ev.key === '=') {
      cam.k *= 1.2;
      applyCam();
    }
    if (ev.key === '-') {
      cam.k /= 1.2;
      applyCam();
      if (focus && cam.k < focus.k * 0.45) surfaceOut();
    }
  });
  addEventListener('resize', () => {
    W = innerWidth;
    H = innerHeight;
    applyCam();
  });

  /* ---------------- start ---------------- */
  renderWorld();
  renderToolbar();
  renderCrumbs();
  cam = fitTo(worldBox);
  applyCam();
  const start = decodeURIComponent(location.hash.slice(1));
  if (start && P.has(start)) setTimeout(() => dive(start), 300);
})();
