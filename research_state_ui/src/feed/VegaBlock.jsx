import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../store/useTheme';

// The design system as a Vega config, read from the live tokens so it follows
// the theme. Loaded lazily with vega-embed — the feed pays for Vega only when
// a `vega` attachment is on screen.
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function mervVegaConfig() {
  const text = cssVar('--text');
  const muted = cssVar('--muted');
  const faint = cssVar('--faint');
  const grid = cssVar('--line-strong');
  const font = cssVar('--font-body') || '-apple-system, BlinkMacSystemFont, "SF Pro Text", Helvetica, Arial, sans-serif';
  return {
    background: 'transparent',
    font,
    padding: 4,
    view: { stroke: null },
    axis: {
      domain: false, ticks: false, grid: true, gridColor: grid, gridDash: [2, 4], gridWidth: 1,
      labelColor: faint, labelFontSize: 10.5, labelPadding: 6,
      titleColor: muted, titleFontSize: 11, titleFontWeight: 500, titlePadding: 8, tickCount: 4,
    },
    axisX: { grid: false },
    axisBand: { grid: false },
    axisDiscrete: { grid: false },
    legend: {
      labelColor: muted, labelFontSize: 11, labelLimit: 0, titleColor: muted, titleFontSize: 11,
      orient: 'bottom', direction: 'horizontal', symbolType: 'stroke', symbolStrokeWidth: 2, symbolSize: 120,
      padding: 0, offset: 8, gradientLength: 120, gradientThickness: 8,
    },
    range: {
      category: [cssVar('--steel'), cssVar('--mcp'), cssVar('--qualifies'), cssVar('--supports'), cssVar('--refutes'), faint],
      heatmap: { scheme: 'blues' },
      ramp: { scheme: 'blues' },
    },
    line: { strokeWidth: 2 },
    point: { size: 40, filled: true },
    circle: { size: 40 },
    bar: { cornerRadiusEnd: 2 },
    rect: { stroke: cssVar('--bg-soft'), strokeWidth: 1 },
    rule: { color: faint, strokeDash: [2, 3] },
    text: { color: muted, fontSize: 11 },
    title: { color: text, fontSize: 12.5, fontWeight: 600, anchor: 'start', offset: 8 },
    mark: { tooltip: true },
  };
}

// Make a spec fill its card: container width unless the author fixed one, a
// modest default height, and fit-x autosize. Compound specs (facet, repeat,
// concat) keep their own sizing — container width is not defined for them.
function fitSpec(spec) {
  const compound = ['facet', 'repeat', 'hconcat', 'vconcat', 'concat'].some((k) => k in spec);
  const out = { ...spec };
  if (!compound) {
    if (out.width == null) out.width = 'container';
    if (out.height == null) out.height = 200;
    if (out.autosize == null) out.autosize = { type: 'fit-x', contains: 'padding' };
  }
  return out;
}

export default function VegaBlock({ a }) {
  const boxRef = useRef(null);
  const { theme } = useTheme();
  const [state, setState] = useState('loading'); // loading | ready | error
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let view = null;
    setState('loading');
    import('vega-embed')
      .then(({ default: embed }) => {
        if (cancelled || !boxRef.current) return null;
        return embed(boxRef.current, fitSpec(a.spec), {
          actions: false,
          renderer: 'svg',
          config: mervVegaConfig(),
          // No remote loads: data must be inline (the brain also refuses url keys).
          loader: { load: () => Promise.reject(new Error('remote data is not allowed in feed charts')) },
        });
      })
      .then((result) => {
        if (cancelled) { result?.view?.finalize?.(); return; }
        view = result?.view || null;
        setState('ready');
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e?.message || e));
        setState('error');
      });
    return () => {
      cancelled = true;
      view?.finalize?.();
    };
  }, [a, theme]);

  return (
    <div className="pa pa-vega">
      {a.title && <p className="pa-chart-t"><b>{a.title}</b></p>}
      <div ref={boxRef} className={`pa-vega-view${state === 'ready' ? ' is-ready' : ''}`} />
      {state === 'loading' && <p className="pa-vega-note">drawing chart…</p>}
      {state === 'error' && <p className="pa-vega-note pa-vega-note--err">chart failed to render: {error}</p>}
    </div>
  );
}
