import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../store/useTheme';

// Mermaid, loaded lazily and rendered under securityLevel 'strict' (labels
// are sanitized, click callbacks are inert). Colors come from the live design
// tokens so a diagram follows the theme; the mark stays quiet — muted strokes,
// soft fills, no rainbow.
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

let counter = 0;

function mermaidTheme() {
  const text = cssVar('--text');
  const muted = cssVar('--muted');
  const line = cssVar('--line-strong');
  const soft = cssVar('--bg-soft');
  const elev = cssVar('--bg-elev');
  return {
    theme: 'base',
    themeVariables: {
      fontFamily: cssVar('--font-body') || '-apple-system, BlinkMacSystemFont, "SF Pro Text", Helvetica, Arial, sans-serif',
      fontSize: '13px',
      background: 'transparent',
      primaryColor: elev,
      primaryTextColor: text,
      primaryBorderColor: line,
      secondaryColor: soft,
      secondaryTextColor: text,
      secondaryBorderColor: line,
      tertiaryColor: soft,
      tertiaryTextColor: text,
      tertiaryBorderColor: line,
      lineColor: muted,
      textColor: text,
      mainBkg: elev,
      nodeBorder: line,
      clusterBkg: soft,
      clusterBorder: line,
      titleColor: text,
      edgeLabelBackground: soft,
      noteBkgColor: soft,
      noteTextColor: text,
      noteBorderColor: line,
      actorBkg: elev,
      actorBorder: line,
      actorTextColor: text,
      signalColor: muted,
      signalTextColor: text,
      labelBoxBkgColor: soft,
      labelTextColor: text,
      loopTextColor: text,
      activationBkgColor: soft,
      activationBorderColor: line,
      sequenceNumberColor: elev,
    },
  };
}

export default function DiagramBlock({ a }) {
  const { theme } = useTheme();
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const idRef = useRef(`feed-diagram-${(counter += 1)}`);

  useEffect(() => {
    let cancelled = false;
    setError('');
    import('mermaid')
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', ...mermaidTheme() });
        const { svg: rendered } = await mermaid.render(`${idRef.current}-${theme}`, a.text);
        if (!cancelled) setSvg(rendered);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message || e).split('\n')[0]);
      });
    return () => { cancelled = true; };
  }, [a, theme]);

  return (
    <div className="pa pa-diagram">
      {error
        ? <p className="pa-vega-note pa-vega-note--err">diagram failed to render: {error}</p>
        : svg
          // Mermaid's strict mode sanitizes labels before it hands back the SVG.
          ? <div className="pa-diagram-svg" dangerouslySetInnerHTML={{ __html: svg }} />
          : <p className="pa-vega-note">drawing diagram…</p>}
    </div>
  );
}
