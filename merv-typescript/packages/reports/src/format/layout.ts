// Place body blocks on a column grid. Each block spans whole columns (1, 2 or 3) and keeps reading
// order; a beam search picks spans and start columns so every column ends near the page bottom.
// Spare space then goes to elastic charts, then to each column's own trailing gaps. Text is never
// scaled.

const W = { waste: 1, residual: 1, pageBreak: 4000, order: 400, overflow: 1e6, ragged: 0.25 };

export interface LayoutBlock {
  id: string;
  options: { span: number; h: number }[];
  elastic: number;
}
export interface Geometry {
  cols: number;
  gap: number;
  pageHeight(page: number): number;
}
export interface Placed {
  id: string;
  page: number;
  col: number;
  span: number;
  top: number;
  h: number;
  elastic: number;
  extra: number;
}
export interface Layout {
  placed: Placed[];
  pages: { page: number; height: number; columnEnds: number[]; unfilled: number[] }[];
}
interface State {
  page: number;
  H: number[];
  placed: Placed[];
  cost: number;
  prev: { page: number; col: number; top: number } | null;
}

export function solveLayout(blocks: LayoutBlock[], geo: Geometry, beamWidth = 400): Layout {
  let beam: State[] = [{ page: 0, H: Array(geo.cols).fill(0), placed: [], cost: 0, prev: null }];
  for (const b of blocks) {
    const next: State[] = [];
    for (const s of beam)
      for (const opt of b.options)
        for (let c = 0; c + opt.span <= geo.cols; c++) next.push(place(s, b, opt, c, geo));
    next.sort((a, z) => a.cost - z.cost);
    beam = dedupe(next).slice(0, beamWidth);
  }
  const scored = beam.map((s) => ({ s, total: s.cost + pageCost(s, geo, true) }));
  scored.sort((a, z) => a.total - z.total);
  return fill(scored[0]?.s.placed ?? [], geo);
}

function place(s: State, b: LayoutBlock, opt: { span: number; h: number }, c: number, geo: Geometry): State {
  let { page, H } = s;
  let cost = s.cost;
  const cov = range(c, c + opt.span);
  const start = (i: number) => (H[i] > 0 ? H[i] + geo.gap : 0);
  let top = Math.max(...cov.map(start));
  if (top + opt.h > geo.pageHeight(page) && H.some((h) => h > 0)) {
    cost += W.pageBreak + pageCost(s, geo, false);
    page += 1;
    H = Array(geo.cols).fill(0);
    top = 0;
  }
  const waste = cov.reduce((sum, i) => sum + Math.max(0, top - start(i)), 0);
  cost += W.waste * waste;
  if (top + opt.h > geo.pageHeight(page)) cost += W.overflow;
  const prev = s.prev;
  if (prev && prev.page === page && c < prev.col && top < prev.top - 1) cost += W.order;
  const H2 = H.slice();
  for (const i of cov) H2[i] = top + opt.h;
  const rec: Placed = { id: b.id, page, col: c, span: opt.span, top, h: opt.h, elastic: b.elastic, extra: 0 };
  return { page, H: H2, placed: [...s.placed, rec], cost, prev: { page, col: c, top } };
}

// Unfillable space at the bottom of the current page, after elastic growth and gap stretch.
function pageCost(s: State, geo: Geometry, final: boolean): number {
  const pageH = geo.pageHeight(s.page);
  const onPage = s.placed.filter((p) => p.page === s.page);
  let cost = 0;
  const maxH = Math.max(...s.H);
  for (let i = 0; i < geo.cols; i++) {
    const inCol = onPage.filter((p) => p.col <= i && i < p.col + p.span);
    const cap = inCol.reduce((sum, p) => sum + p.elastic, 0) + Math.max(0, inCol.length - 1) * geo.gap * 2;
    cost += W.residual * Math.max(0, pageH - s.H[i] - cap);
    if (final) cost += W.ragged * (maxH - s.H[i]);
  }
  return cost;
}

function dedupe(states: State[]): State[] {
  const seen = new Set<string>();
  return states.filter((s) => {
    const key = `${s.page}:${s.H.map((h) => Math.round(h / 4)).join(',')}:${s.placed.map((p) => `${p.span}${p.col}`).join('')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);

/** Recompute tops for fixed spans and columns given block heights and per-page gaps. */
function positions(placed: Placed[], heights: Record<string, number>, geo: Geometry, gaps: Record<number, number>) {
  const out: Placed[] = [];
  const ends: Record<number, number[]> = {};
  for (const p of placed) {
    const H = (ends[p.page] ??= Array(geo.cols).fill(0));
    const gap = gaps[p.page] ?? geo.gap;
    const cov = range(p.col, p.col + p.span);
    const top = Math.max(...cov.map((i) => (H[i] > 0 ? H[i] + gap : 0)));
    const h = heights[p.id];
    for (const i of cov) H[i] = top + h;
    out.push({ ...p, top, h });
  }
  return { placed: out, ends };
}

function fits(placed: Placed[], heights: Record<string, number>, geo: Geometry, gaps: Record<number, number>, page: number) {
  const { ends } = positions(placed, heights, geo, gaps);
  return (ends[page] ?? []).every((e) => e <= geo.pageHeight(page) + 0.5);
}

function fill(placed: Placed[], geo: Geometry): Layout {
  const heights = Object.fromEntries(placed.map((p) => [p.id, p.h]));
  const extra = Object.fromEntries(placed.map((p) => [p.id, 0]));
  const gaps: Record<number, number> = {};
  const pages = [...new Set(placed.map((p) => p.page))];
  for (const page of pages) {
    const mine = placed.filter((p) => p.page === page && p.elastic > 0);
    for (let grew = true; grew; ) {
      grew = false;
      for (const p of mine) {
        if (extra[p.id] + 4 > p.elastic) continue;
        heights[p.id] += 4;
        if (fits(placed, heights, geo, gaps, page)) {
          extra[p.id] += 4;
          grew = true;
        } else heights[p.id] -= 4;
      }
    }
    let lo = geo.gap;
    let hi = geo.gap * 2;
    for (let k = 0; k < 20; k++) {
      const mid = (lo + hi) / 2;
      if (fits(placed, heights, geo, { ...gaps, [page]: mid }, page)) lo = mid;
      else hi = mid;
    }
    gaps[page] = lo;
  }
  const laid = positions(placed, heights, geo, gaps).placed;
  const final = justifyColumns(laid, geo);
  const ends: Record<number, number[]> = {};
  for (const p of final) {
    const H = (ends[p.page] ??= Array(geo.cols).fill(0));
    for (let i = p.col; i < p.col + p.span; i++) H[i] = Math.max(H[i], p.top + p.h);
  }
  return {
    placed: final.map((p) => ({ ...p, extra: extra[p.id] })),
    pages: pages.map((page) => ({
      page,
      height: geo.pageHeight(page),
      columnEnds: ends[page],
      unfilled: ends[page].map((e) => Math.max(0, Math.round(geo.pageHeight(page) - e))),
    })),
  };
}

// A column whose last blocks are its own (span 1) spreads its leftover space over the gaps above
// them, so columns end together while block tops stay varied.
function justifyColumns(placed: Placed[], geo: Geometry): Placed[] {
  const out = placed.map((p) => ({ ...p }));
  for (const page of new Set(out.map((p) => p.page))) {
    const pageH = geo.pageHeight(page);
    for (let col = 0; col < geo.cols; col++) {
      const inCol = out
        .filter((p) => p.page === page && p.col <= col && col < p.col + p.span)
        .sort((a, b) => a.top - b.top);
      if (!inCol.length) continue;
      let start = inCol.length;
      while (start > 0 && inCol[start - 1].span === 1) start--;
      const run = inCol.slice(start);
      if (!run.length) continue;
      const gaps = start === 0 ? run.length - 1 : run.length;
      if (!gaps) continue;
      const end = run[run.length - 1].top + run[run.length - 1].h;
      const each = Math.min((pageH - end) / gaps, geo.gap * 2);
      if (each <= 0) continue;
      run.forEach((p, k) => {
        p.top += each * (start === 0 ? k : k + 1);
      });
    }
  }
  return out;
}
