/**
 * Shapes opens the lower tray of shapes and drawing tools. Native toolbar buttons for these
 * choices are hidden; their keyboard shortcuts continue to work.
 */
import { useEffect, useRef, useState } from 'react';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

type Tool = 'ellipse' | 'rectangle' | 'diamond' | 'arrow' | 'line' | 'image';

const ICON: Record<Tool | 'tools', string> = {
  tools:
    'M5.5 3l2.5 2.5L5.5 8 3 5.5zM14.5 3.2a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8zM3.2 12h4.6v4.6H3.2zM14.5 11.6l2.8 5H11.7z',
  ellipse: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14z',
  rectangle: 'M3 3h14v14H3z',
  diamond: 'M10 2.8 17.2 10 10 17.2 2.8 10z',
  arrow: 'M3.5 16.5 16 4M9 4h7v7',
  line: 'M3.5 16.5 16.5 3.5',
  image: 'M3 4h14v12H3zM3 13l4-4 3 3 2-2 5 5M12.5 7.5h.01',
};
const TOOLS: { tool: Tool; label: string }[] = [
  { tool: 'ellipse', label: 'Ellipse — O' },
  { tool: 'rectangle', label: 'Rectangle — R' },
  { tool: 'diamond', label: 'Diamond — D' },
  { tool: 'arrow', label: 'Arrow — A' },
  { tool: 'line', label: 'Line — L' },
  { tool: 'image', label: 'Image' },
];

const Glyph = ({ name }: { name: Tool | 'tools' }) => (
  <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
    <path
      d={ICON[name]}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export function BoardTools({ api }: { api?: ExcalidrawImperativeAPI | null }) {
  const [open, setOpen] = useState(false);
  const [held, setHeld] = useState<string>();
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    setHeld(api?.getAppState().activeTool.type);
    return api?.onChange((_, state) => setHeld(state.activeTool.type));
  }, [api]);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) =>
      !box.current?.contains(event.target as Node) && setOpen(false);
    const key = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    addEventListener('pointerdown', away, true);
    addEventListener('keydown', key, true);
    return () => (
      removeEventListener('pointerdown', away, true),
      removeEventListener('keydown', key, true)
    );
  }, [open]);
  const pick = (tool: Tool) => {
    setOpen(false);
    if (!api) return;
    // The image tool opens a file picker, which only Excalidraw's own (hidden) button can do.
    if (tool === 'image')
      return document
        .querySelector<HTMLElement>('.excalidraw [data-testid="toolbar-image"]')
        ?.click();
    api.setActiveTool({ type: tool });
  };
  const shown = TOOLS.find(({ tool }) => tool === held && tool !== 'image')?.tool;
  return (
    <span className="board-tools" ref={box}>
      <button
        type="button"
        className={`ToolIcon_type_button ToolIcon_size_medium ToolIcon${open || shown ? ' is-on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Shapes"
        title="Shapes"
        onClick={() => setOpen(!open)}
      >
        <div className="ToolIcon__icon">
          <Glyph name="tools" />
        </div>
      </button>
      {open && (
        <span className="board-tools-menu" role="menu">
          {TOOLS.map(({ tool, label }) => (
            <button
              key={tool}
              type="button"
              role="menuitem"
              title={label}
              aria-label={label}
              className={held === tool ? 'is-on' : ''}
              onClick={() => pick(tool)}
            >
              <Glyph name={tool} />
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
