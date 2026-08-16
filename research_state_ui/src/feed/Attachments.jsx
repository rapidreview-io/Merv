import { lazy, Suspense } from 'react';
import { useAuthedImage } from './useAuthedImage';

/**
 * Native post attachments, drawn by the UI from the data in the post so they
 * sit in the design system on both themes: a stat (one number), a chart
 * (line/bars/scatter), a heatmap, a table, a log block, a Mermaid diagram, a
 * Vega-Lite chart, and a figure reused from an artifact. Every attachment
 * lives in the same soft well; the type decides the renderer, not the frame.
 * Vega and Mermaid load lazily — the feed pays for them only when needed.
 */
const VegaBlock = lazy(() => import('./VegaBlock'));
const DiagramBlock = lazy(() => import('./DiagramBlock'));

function Stat({ a }) {
  return (
    <div className="pa pa-stat" role="img" aria-label={`${a.value}${a.unit ? ` ${a.unit}` : ''}${a.delta ? `, ${a.delta}` : ''}`}>
      <div className="pa-stat-v">
        {a.value}
        {a.unit && <small>{a.unit}</small>}
      </div>
      {(a.delta || a.baseline) && (
        <div className="pa-stat-d">
          {a.delta && <b>{a.delta}</b>}
          {a.delta && a.baseline && ' · '}
          {a.baseline}
        </div>
      )}
      {a.note && <div className="pa-stat-l">{a.note}</div>}
    </div>
  );
}

// -- chart -------------------------------------------------------------------

const W = 560;
const H = 200;
const PAD = { l: 44, r: 16, t: 14, b: 30 };
const SERIES_CLASS = ['pa-s0', 'pa-s1', 'pa-s2', 'pa-s3', 'pa-s4', 'pa-s5'];

function niceTicks(min, max, count = 4) {
  if (!(max > min)) return [min];
  const span = max - min;
  const rough = span / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

function fmt(v) {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Number.isInteger(v)) return String(v);
  if (abs >= 10) return v.toFixed(1).replace(/\.0$/, '');
  return v.toFixed(2).replace(/\.?0+$/, '');
}

// Extend a tick list so the top tick sits at or above the data's max — the
// highest point never touches the frame.
function withHeadroom(ticks, max) {
  if (ticks.length < 2) return ticks;
  const step = ticks[1] - ticks[0];
  const last = ticks[ticks.length - 1];
  return last < max ? [...ticks, Number((last + step).toFixed(10))] : ticks;
}

function Legend({ series }) {
  if (series.length < 2) return null;
  return (
    <div className="pa-legend">
      {series.map((s, i) => (
        <span key={i}><i className={SERIES_CLASS[i % SERIES_CLASS.length]} />{s.name || `series ${i + 1}`}</span>
      ))}
    </div>
  );
}

function LineChart({ a, scatter = false }) {
  const series = a.series || [];
  const xs = series.flatMap((s) => s.points.map((p) => p[0]));
  const ys = series.flatMap((s) => s.points.map((p) => p[1]));
  if (a.ref_line) ys.push(a.ref_line.value);
  let xMin = Math.min(...xs); let xMax = Math.max(...xs);
  let yMin = Math.min(0, ...ys); let yMax = Math.max(...ys);
  if (xMax === xMin) { xMin -= 1; xMax += 1; }
  if (yMax === yMin) { yMax = yMin + 1; }
  const yTicks = withHeadroom(niceTicks(yMin, yMax), yMax);
  yMax = Math.max(yMax, yTicks[yTicks.length - 1] ?? yMax);
  const sx = (x) => PAD.l + ((x - xMin) / (xMax - xMin)) * (W - PAD.l - PAD.r);
  const sy = (y) => H - PAD.b - ((y - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);
  const xTicks = niceTicks(xMin, xMax, 5).filter((v) => v >= xMin && v <= xMax);
  const hero = a.hero && series[a.hero.series]?.points?.[a.hero.index];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="pa-chart-svg" role="img" aria-label={a.title || 'chart'}>
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line className="pa-grid" x1={PAD.l} x2={W - PAD.r} y1={sy(t)} y2={sy(t)} strokeDasharray={t === yTicks[0] ? undefined : '2 4'} />
          <text className="pa-ax" x={PAD.l - 6} y={sy(t) + 3.5} textAnchor="end">{fmt(t)}</text>
        </g>
      ))}
      {xTicks.map((t) => (
        <text key={`x${t}`} className="pa-ax" x={sx(t)} y={H - PAD.b + 14} textAnchor="middle">{fmt(t)}</text>
      ))}
      {a.x_label && <text className="pa-ax" x={(PAD.l + W - PAD.r) / 2} y={H - 4} textAnchor="middle">{a.x_label}</text>}
      {a.y_label && <text className="pa-ax" x={10} y={PAD.t + 4} textAnchor="start">{a.y_label}</text>}
      {a.ref_line && (
        <g>
          <line className="pa-ref" x1={PAD.l} x2={W - PAD.r} y1={sy(a.ref_line.value)} y2={sy(a.ref_line.value)} />
          {a.ref_line.label && (
            <text className="pa-lbl" x={W - PAD.r} y={sy(a.ref_line.value) + 12} textAnchor="end">{a.ref_line.label}</text>
          )}
        </g>
      )}
      {series.map((s, i) => (
        <g key={i} className={SERIES_CLASS[i % SERIES_CLASS.length]}>
          {!scatter && <polyline className="pa-line" points={s.points.map((p) => `${sx(p[0])},${sy(p[1])}`).join(' ')} />}
          {(scatter || s.points.length <= 24) && s.points.map((p, j) => (
            <circle key={j} className={scatter ? 'pa-dot pa-dot--scatter' : 'pa-dot'} cx={sx(p[0])} cy={sy(p[1])} r={scatter ? 3.4 : 2.6} />
          ))}
        </g>
      ))}
      {hero && (
        <g>
          <circle className="pa-hero" cx={sx(hero[0])} cy={sy(hero[1])} r="5" />
          <text className="pa-lbl-hero" x={sx(hero[0])} y={sy(hero[1]) - 10} textAnchor="middle">{fmt(hero[1])}{a.unit ? ` ${a.unit}` : ''}</text>
        </g>
      )}
    </svg>
  );
}

function BarsChart({ a }) {
  const series = a.series || [];
  const labels = a.labels || [];
  const values = series.flatMap((s) => s.values);
  if (a.ref_line) values.push(a.ref_line.value);
  const yMin = Math.min(0, ...values);
  let yMax = Math.max(...values, 0);
  if (yMax === yMin) yMax = yMin + 1;
  const yTicks = withHeadroom(niceTicks(yMin, yMax), yMax);
  yMax = Math.max(yMax, yTicks[yTicks.length - 1] ?? yMax);
  const sy = (y) => H - PAD.b - ((y - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);
  const groupW = (W - PAD.l - PAD.r) / labels.length;
  const barW = Math.min(28, (groupW * 0.7) / series.length);
  const hero = a.hero;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="pa-chart-svg" role="img" aria-label={a.title || 'chart'}>
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line className="pa-grid" x1={PAD.l} x2={W - PAD.r} y1={sy(t)} y2={sy(t)} strokeDasharray={t === yTicks[0] ? undefined : '2 4'} />
          <text className="pa-ax" x={PAD.l - 6} y={sy(t) + 3.5} textAnchor="end">{fmt(t)}</text>
        </g>
      ))}
      {labels.map((label, li) => {
        const cx = PAD.l + groupW * (li + 0.5);
        const total = barW * series.length + 2 * (series.length - 1);
        return (
          <g key={li}>
            {series.map((s, si) => {
              const v = s.values[li];
              const x = cx - total / 2 + si * (barW + 2);
              const y0 = sy(Math.max(0, v));
              const y1 = sy(Math.min(0, v));
              const isHero = hero && hero.series === si && hero.index === li;
              return (
                <g key={si} className={SERIES_CLASS[si % SERIES_CLASS.length]}>
                  <rect className={`pa-bar${isHero ? ' pa-bar--hero' : ''}`} x={x} y={y0} width={barW} height={Math.max(1, y1 - y0)} rx="2" />
                  {(isHero || series.length === 1) && (
                    <text className={isHero ? 'pa-lbl-hero' : 'pa-lbl'} x={x + barW / 2} y={y0 - 5} textAnchor="middle">{fmt(v)}</text>
                  )}
                </g>
              );
            })}
            <text className="pa-ax" x={cx} y={H - PAD.b + 14} textAnchor="middle">{label}</text>
          </g>
        );
      })}
      {a.ref_line && (
        <g>
          <line className="pa-ref" x1={PAD.l} x2={W - PAD.r} y1={sy(a.ref_line.value)} y2={sy(a.ref_line.value)} />
          {a.ref_line.label && (
            <text className="pa-lbl" x={W - PAD.r} y={sy(a.ref_line.value) - 4} textAnchor="end">{a.ref_line.label}</text>
          )}
        </g>
      )}
    </svg>
  );
}

function Chart({ a }) {
  return (
    <div className="pa pa-chart">
      {(a.title || a.unit) && (
        <p className="pa-chart-t">
          <b>{a.title}</b>
          {a.unit && <span>{a.unit}</span>}
        </p>
      )}
      {a.kind === 'bars' ? <BarsChart a={a} /> : <LineChart a={a} scatter={a.kind === 'scatter'} />}
      <Legend series={a.series || []} />
    </div>
  );
}

function Table({ a }) {
  return (
    <div className="pa pa-table">
      <table>
        <thead><tr>{a.columns.map((c, i) => <th key={i} className={i > 0 ? 'r' : ''}>{c}</th>)}</tr></thead>
        <tbody>
          {a.rows.map((row, ri) => (
            <tr key={ri} className={a.hero_row === ri ? 'hero' : ''}>
              {row.map((cell, ci) => <td key={ci} className={ci > 0 ? 'r' : ''}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {a.caption && <p className="pa-cap">{a.caption}</p>}
    </div>
  );
}

function Log({ a }) {
  const highlight = new Set(a.highlight || []);
  return (
    <pre className="pa pa-log">
      {a.text.split('\n').map((line, i) => (
        <span key={i} className={highlight.has(i) ? 'hi' : undefined}>{line}{'\n'}</span>
      ))}
    </pre>
  );
}

// A matrix as cells on a single-hue ramp: the design system's steel mixed
// into the well's surface, so it reads on both themes without a colormap.
function Heatmap({ a }) {
  const flat = a.values.flat();
  const vmin = a.vmin ?? Math.min(...flat);
  const vmax = a.vmax ?? Math.max(...flat);
  const span = vmax - vmin || 1;
  const cols = a.cols.length;
  const rows = a.rows.length;
  const labelW = 64;
  const cellW = Math.max(28, Math.min(64, (W - labelW - 8) / cols));
  const cellH = cols > 12 || rows > 12 ? 20 : 26;
  const width = labelW + cellW * cols + 8;
  const height = 22 + cellH * rows;
  const annotate = a.annotate ?? (cols <= 10 && rows <= 10);
  return (
    <div className="pa pa-chart pa-heatmap">
      {(a.title || a.unit) && (
        <p className="pa-chart-t"><b>{a.title}</b>{a.unit && <span>{a.unit}</span>}</p>
      )}
      <svg viewBox={`0 0 ${width} ${height}`} className="pa-chart-svg" role="img" aria-label={a.title || 'heatmap'}>
        {a.cols.map((c, ci) => (
          <text key={`c${ci}`} className="pa-ax" x={labelW + cellW * (ci + 0.5)} y={13} textAnchor="middle">{c}</text>
        ))}
        {a.rows.map((r, ri) => (
          <g key={`r${ri}`}>
            <text className="pa-ax" x={labelW - 8} y={22 + cellH * (ri + 0.5) + 3.5} textAnchor="end">{r}</text>
            {a.values[ri].map((v, ci) => {
              const t = Math.max(0, Math.min(1, (v - vmin) / span));
              const pct = Math.round(8 + t * 84);
              return (
                <g key={`c${ci}`}>
                  <rect
                    className="pa-cell"
                    x={labelW + cellW * ci + 1} y={22 + cellH * ri + 1} width={cellW - 2} height={cellH - 2} rx="2"
                    style={{ fill: `color-mix(in oklab, var(--steel) ${pct}%, var(--bg-soft))` }}
                  />
                  {annotate && (
                    <text
                      className={`pa-cell-v${t > 0.55 ? ' pa-cell-v--light' : ''}`}
                      x={labelW + cellW * (ci + 0.5)} y={22 + cellH * (ri + 0.5) + 3.5} textAnchor="middle"
                    >
                      {fmt(v)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        ))}
      </svg>
    </div>
  );
}

// A figure already submitted with an artifact, served through the artifact
// figure route the brain enriched onto the attachment (authed fetch).
function Figure({ a }) {
  const image = useAuthedImage(a.url);
  if (image.failed) return <p className="pa-vega-note">figure unavailable: {a.path}</p>;
  return (
    <figure className="pa-figure">
      <div className="postcard-media">
        {image.url && <img src={image.url} alt={a.caption || a.path} className="postcard-image is-loaded" />}
      </div>
      <figcaption className="pa-cap">{a.caption || a.path}</figcaption>
    </figure>
  );
}

function Lazy({ children }) {
  return <Suspense fallback={<div className="pa"><p className="pa-vega-note">loading…</p></div>}>{children}</Suspense>;
}

const RENDERERS = {
  stat: Stat,
  chart: Chart,
  heatmap: Heatmap,
  table: Table,
  log: Log,
  figure: Figure,
  diagram: (props) => <Lazy><DiagramBlock {...props} /></Lazy>,
  vega: (props) => <Lazy><VegaBlock {...props} /></Lazy>,
};

export default function Attachments({ items }) {
  if (!items || !items.length) return null;
  return (
    <>
      {items.map((a, i) => {
        const R = RENDERERS[a?.type];
        return R ? <R key={i} a={a} /> : null;
      })}
    </>
  );
}
