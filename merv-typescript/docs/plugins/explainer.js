// Renders one explainer page from the JSON in <script id="page" type="application/json">.
// No dependencies and no network: every page works when opened straight from disk.
(() => {
  const page = JSON.parse(document.getElementById('page').textContent);
  const SVG = 'http://www.w3.org/2000/svg';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else node.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  };
  const svg = (tag, attrs = {}) => {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  // Inline **bold** only; everything else is plain text.
  const rich = (text) => {
    const span = document.createElement('span');
    text.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
      if (part.startsWith('**') && part.endsWith('**')) span.append(el('b', {}, part.slice(2, -2)));
      else span.append(part);
    });
    return span;
  };

  // Theme: auto -> light -> dark, remembered per browser when storage is available.
  const root = document.documentElement;
  const themes = ['auto', 'light', 'dark'];
  let theme = 'auto';
  try {
    theme = localStorage.getItem('merv-explainer-theme') || 'auto';
  } catch {}
  const applyTheme = () => {
    if (theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  };
  applyTheme();

  document.title = page.title || `${page.name} — Merv`;
  const main = el('main');
  document.body.append(main);

  const themeButton = el('button', { class: 'theme', type: 'button' });
  const labelTheme = () => (themeButton.textContent = `Theme: ${theme}`);
  labelTheme();
  themeButton.addEventListener('click', () => {
    theme = themes[(themes.indexOf(theme) + 1) % themes.length];
    try {
      localStorage.setItem('merv-explainer-theme', theme);
    } catch {}
    applyTheme();
    labelTheme();
  });
  main.append(
    el(
      'nav',
      { class: 'top' },
      page.index
        ? el('span', {}, 'Merv plugins')
        : el('a', { href: 'index.html' }, '← All plugins'),
      themeButton,
    ),
  );

  const hero = el('header', { class: 'hero' });
  if (page.group)
    hero.append(
      el(
        'span',
        { class: `badge ${page.group}` },
        page.group === 'research' ? 'Research logic' : 'Foundation',
      ),
    );
  hero.append(el('h1', {}, page.name), el('p', { class: 'tagline' }, rich(page.tagline)));
  main.append(hero);

  if (page.analogy)
    main.append(
      el(
        'section',
        {},
        el('h2', {}, 'Think of it like…'),
        el(
          'div',
          { class: 'analogy' },
          el('span', { class: 'icon', 'aria-hidden': 'true' }, page.analogy.icon || '💡'),
          el('p', {}, rich(page.analogy.text)),
        ),
      ),
    );

  if (page.why?.length) {
    const list = el('ul', { class: 'plain' });
    page.why.forEach((line) => list.append(el('li', {}, rich(line))));
    main.append(el('section', {}, el('h2', {}, page.whyTitle || 'Why it exists'), list));
  }

  // The map: this plugin in the middle, the plugins it works with around it.
  const neighbors = page.neighbors || [];
  if (neighbors.length) {
    const W = 880;
    const H = neighbors.length > 8 ? 600 : 520;
    const cx = W / 2;
    const cy = H / 2;
    const R = 50;
    const spots = new Map();
    spots.set('self', { x: cx, y: cy });
    neighbors.forEach((n, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / neighbors.length;
      spots.set(n.id, {
        x: cx + Math.cos(angle) * (W / 2 - R - 24),
        y: cy + Math.sin(angle) * (H / 2 - R - 14),
      });
    });
    const map = svg('svg', {
      class: 'map',
      viewBox: `0 0 ${W} ${H}`,
      role: 'img',
      'aria-label': `${page.name} and the parts of Merv it works with`,
    });
    const edges = new Map();
    const nodes = new Map();
    for (const n of neighbors) {
      const a = spots.get('self');
      const b = spots.get(n.id);
      const line = svg('line', { class: 'edge', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      map.append(line);
      edges.set(n.id, line);
    }
    const label = (g, name, size) => {
      const words = name.split(' ');
      const lines =
        words.length > 1 && name.length > 10 ? [words[0], words.slice(1).join(' ')] : [name];
      lines.forEach((line, i) => {
        const t = svg('text', { x: 0, y: (i - (lines.length - 1) / 2) * (size + 2) });
        t.textContent = line;
        g.append(t);
      });
    };
    const drawNode = (id, name, kind, x, y, r, center) => {
      const g = svg('g', {
        class: `node ${kind}${center ? ' center' : ''}`,
        transform: `translate(${x} ${y})`,
        tabindex: '0',
        role: 'button',
        'aria-label': name,
      });
      if (center) g.append(svg('circle', { class: 'pulse', r }));
      g.append(svg('circle', { r }));
      label(g, name, center ? 17 : 14);
      map.append(g);
      nodes.set(id, g);
      return g;
    };
    neighbors.forEach((n) => {
      const p = spots.get(n.id);
      drawNode(n.id, n.name, n.kind || 'foundation', p.x, p.y, R, false);
    });
    drawNode('self', page.name, page.group || 'foundation', cx, cy, R + 14, true);
    const token = svg('circle', { class: 'token', r: 9, cx, cy, opacity: 0 });
    map.append(token);

    const info = el('div', { class: 'info', 'aria-live': 'polite' });
    const hint = page.mapHint || 'Tap or click a circle to see what passes between them.';
    const resetInfo = () => {
      info.replaceChildren(el('span', {}, hint));
    };
    resetInfo();
    const clearOn = () => {
      edges.forEach((e) => e.classList.remove('on'));
      nodes.forEach((n) => n.classList.remove('on'));
    };
    const select = (id) => {
      clearOn();
      if (id === 'self') {
        nodes.get('self').classList.add('on');
        info.replaceChildren(el('strong', {}, page.name), rich(page.tagline));
        return;
      }
      const n = neighbors.find((x) => x.id === id);
      edges.get(id).classList.add('on');
      nodes.get(id).classList.add('on');
      const arrow =
        n.dir === 'in'
          ? `${n.name} → ${page.name}`
          : n.dir === 'both'
            ? `${page.name} ↔ ${n.name}`
            : `${page.name} → ${n.name}`;
      const box = [el('strong', {}, `${arrow}: ${n.says}`), rich(n.detail || '')];
      const target =
        n.page === undefined
          ? ['foundation', 'research'].includes(n.kind || 'foundation')
            ? `${n.id}.html`
            : null
          : n.page;
      if (target)
        box.push(
          el('div', { class: 'go' }, el('a', { href: target }, `Open the ${n.name} page →`)),
        );
      info.replaceChildren(...box);
    };
    nodes.forEach((g, id) => {
      g.addEventListener('click', () => {
        stop();
        select(id);
      });
      g.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          stop();
          select(id);
        }
      });
    });

    const section = el('section', {}, el('h2', {}, page.mapTitle || 'Who it works with'));
    const wrap = el('div', { class: 'map-wrap' }, map);
    const kinds = new Set(neighbors.map((n) => n.kind || 'foundation'));
    kinds.add(page.group || 'foundation');
    const legend = el('div', { class: 'legend' });
    const names = {
      foundation: 'Foundation',
      research: 'Research logic',
      person: 'People & agents',
      outside: 'Outside Merv',
    };
    for (const k of ['foundation', 'research', 'person', 'outside'])
      if (kinds.has(k)) legend.append(el('span', { class: k }, names[k]));
    section.append(wrap, legend, info);

    // The story: a token travels along the map one step at a time.
    const steps = page.story?.steps || [];
    let at = -1;
    let timer = 0;
    let frame = 0;
    const stepText = el('p', { class: 'step', 'aria-live': 'polite' });
    const dots = el('div', { class: 'dots', 'aria-hidden': 'true' });
    steps.forEach(() => dots.append(el('i')));
    const prev = el('button', { type: 'button' }, '◀ Back');
    const next = el('button', { type: 'button' }, 'Next ▶');
    const play = el('button', { type: 'button', class: 'primary' }, '▶ Play the story');
    const route = (from, to) => {
      // Neighbours only connect through the middle, so a hop between two of them passes it.
      const a = spots.get(from) || spots.get('self');
      const b = spots.get(to) || spots.get('self');
      if (from !== 'self' && to !== 'self' && from !== to) return [a, spots.get('self'), b];
      return [a, b];
    };
    const travel = (points, done) => {
      cancelAnimationFrame(frame);
      if (reduced || points.length < 2) {
        const last = points[points.length - 1];
        token.setAttribute('cx', last.x);
        token.setAttribute('cy', last.y);
        token.setAttribute('opacity', 1);
        done?.();
        return;
      }
      const legs = points.length - 1;
      const ms = 650 * legs;
      const start = performance.now();
      token.setAttribute('opacity', 1);
      const tick = (now) => {
        const t = Math.min(1, (now - start) / ms);
        const leg = Math.min(legs - 1, Math.floor(t * legs));
        const local = t * legs - leg;
        const ease = local < 0.5 ? 2 * local * local : 1 - Math.pow(-2 * local + 2, 2) / 2;
        const a = points[leg];
        const b = points[leg + 1];
        token.setAttribute('cx', a.x + (b.x - a.x) * ease);
        token.setAttribute('cy', a.y + (b.y - a.y) * ease);
        if (t < 1) frame = requestAnimationFrame(tick);
        else done?.();
      };
      frame = requestAnimationFrame(tick);
    };
    const show = (i) => {
      at = Math.max(0, Math.min(steps.length - 1, i));
      const s = steps[at];
      clearOn();
      for (const id of [s.from, s.to]) {
        if (id && id !== 'self' && edges.has(id)) edges.get(id).classList.add('on');
        if (id && nodes.has(id)) nodes.get(id).classList.add('on');
      }
      stepText.replaceChildren(el('b', {}, `Step ${at + 1} of ${steps.length}. `), rich(s.text));
      [...dots.children].forEach((d, k) => d.classList.toggle('on', k <= at));
      prev.disabled = at === 0;
      next.disabled = at === steps.length - 1;
      travel(route(s.from || 'self', s.to || 'self'));
    };
    const stop = () => {
      clearTimeout(timer);
      play.textContent = at >= 0 ? '▶ Play from here' : '▶ Play the story';
      play.dataset.on = '';
    };
    const autoplay = () => {
      if (at >= steps.length - 1) {
        stop();
        play.textContent = '↻ Play again';
        return;
      }
      show(at + 1);
      timer = setTimeout(autoplay, reduced ? 4200 : 3600);
    };
    play.addEventListener('click', () => {
      if (play.dataset.on) return stop();
      if (at >= steps.length - 1) at = -1;
      play.dataset.on = '1';
      play.textContent = '❚❚ Pause';
      autoplay();
    });
    prev.addEventListener('click', () => {
      stop();
      show(at - 1);
    });
    next.addEventListener('click', () => {
      stop();
      show(at + 1);
    });
    if (steps.length) {
      prev.disabled = true;
      section.append(
        el('h2', { style: 'margin-top:18px' }, page.story.title || 'A typical journey'),
        el('div', { class: 'player' }, play, prev, next, dots),
        stepText,
      );
      stepText.append(
        el('span', {}, 'Press play to watch it happen, or step through it yourself.'),
      );
    }
    main.append(section);
  }

  if (page.words?.length) {
    const dl = el('dl', { class: 'words' });
    page.words.forEach((w) => dl.append(el('dt', {}, w.term), el('dd', {}, rich(w.meaning))));
    main.append(el('section', {}, el('h2', {}, 'Words to know'), dl));
  }

  if (page.not?.length) {
    const list = el('ul', { class: 'plain' });
    page.not.forEach((line) => list.append(el('li', {}, rich(line))));
    main.append(el('section', {}, el('h2', {}, 'What it does not do'), list));
  }

  // The index lists every plugin, grouped.
  for (const group of page.catalog || []) {
    const grid = el('div', { class: 'grid' });
    group.items.forEach((item) =>
      grid.append(
        el(
          'a',
          { class: `card ${group.kind}`, href: `${item.id}.html` },
          el('b', {}, item.name),
          el('small', {}, item.tagline),
        ),
      ),
    );
    main.append(
      el(
        'section',
        {},
        el('h2', {}, group.title),
        group.intro ? el('p', { style: 'margin-top:0' }, rich(group.intro)) : null,
        grid,
      ),
    );
  }

  main.append(
    el(
      'footer',
      {},
      page.readme ? el('a', { href: page.readme }, 'The full technical README') : null,
      page.readme ? ' · ' : null,
      'A short guide for anyone new to Merv.',
    ),
  );
})();
