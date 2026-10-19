/** Deliberate 0.18.1 integration hook. Fail closed on dependency upgrades; no DOM injection. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const root = resolve(dirname(require.resolve('@excalidraw/excalidraw')), '../..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
if (pkg.version !== '0.18.1') throw new Error('Review rich hyperlink patch for Excalidraw upgrade');
for (const mode of ['dev', 'prod']) {
  const file = resolve(root, `dist/${mode}/index.js`);
  let source = readFileSync(file, 'utf8');
  if (source.includes('mervRichHyperlinkHook')) {
    if (
      !source.includes('renderHyperlinkDetails') ||
      !source.includes('max(16px, calc(100% - 396px))')
    )
      throw new Error(
        'Installed rich hyperlink patch is stale; reinstall Excalidraw before continuing',
      );
    continue;
  }
  const replace = (before, after) => {
    if (source.split(before).length !== 2)
      throw new Error(`Excalidraw ${mode} patch context changed: ${before.slice(0, 60)}`);
    source = source.replace(before, after);
  };
  if (mode === 'dev') {
    replace(
      '      onLinkOpen,\n      generateLinkForSelection,',
      '      onLinkOpen,\n      renderHyperlinkDetails: props.renderHyperlinkDetails,\n      generateLinkForSelection,',
    );
    replace(
      'top: `${y}px`,\n        left: `${x}px`,\n        width: POPUP_WIDTH,',
      'top: appProps.renderHyperlinkDetails ? `clamp(16px, ${y + 85}px, max(16px, calc(100% - 430px)))` : `${y}px`,\n        left: appProps.renderHyperlinkDetails ? `clamp(16px, ${x + 190 + element.width * appState.zoom.value / 2 + 392 < appState.width ? x + 202 + element.width * appState.zoom.value / 2 : x - 202 - element.width * appState.zoom.value / 2}px, max(16px, calc(100% - 396px)))` : `${x}px`,\n        width: POPUP_WIDTH,',
    );
    replace(
      'if (isEditing) {\n        return;\n      }\n      if (timeoutId)',
      'if (isEditing || appProps.renderHyperlinkDetails) {\n        return;\n      }\n      if (timeoutId)',
    );
    replace(
      'className: "excalidraw-hyperlinkContainer",\n      style:',
      'className: "excalidraw-hyperlinkContainer" + (appProps.renderHyperlinkDetails ? " merv-rich-hyperlink" : ""),\n      style:',
    );
    replace(
      'children: [\n        isEditing ? /* @__PURE__ */ jsx48(',
      'children: [\n        !isEditing && appProps.renderHyperlinkDetails?.(element, () => setAppState({ showHyperlinkPopup: false })),\n        isEditing ? /* @__PURE__ */ jsx48(',
    );
  } else {
    replace(
      'onLinkOpen:S,generateLinkForSelection:I,onPointerDown:_,onPointerUp:k,onScrollChange:R,onDuplicate:M,validateEmbeddable:',
      'onLinkOpen:S,renderHyperlinkDetails:e.renderHyperlinkDetails,generateLinkForSelection:I,onPointerDown:_,onPointerUp:k,onScrollChange:R,onDuplicate:M,validateEmbeddable:',
    );
    replace(
      'top:`${T}px`,left:`${x}px`,width:iu',
      'top:l.renderHyperlinkDetails?`clamp(16px, ${T+85}px, max(16px, calc(100% - 430px)))`:`${T}px`,left:l.renderHyperlinkDetails?`clamp(16px, ${x+190+e.width*a.zoom.value/2+392<a.width?x+202+e.width*a.zoom.value/2:x-202-e.width*a.zoom.value/2}px, max(16px, calc(100% - 396px)))`:`${x}px`,width:iu',
    );
    replace(
      'w=S=>{if(u)return;E&&clearTimeout(E),FI(e,o,a,z(S.clientX,S.clientY))',
      'w=S=>{if(u||l.renderHyperlinkDetails)return;E&&clearTimeout(E),FI(e,o,a,z(S.clientX,S.clientY))',
    );
    replace(
      'className:"excalidraw-hyperlinkContainer",style:',
      'className:"excalidraw-hyperlinkContainer"+(l.renderHyperlinkDetails?" merv-rich-hyperlink":""),style:',
    );
    replace(
      'width:iu,padding:ru},children:[u?Pi("input"',
      'width:iu,padding:ru},children:[!u&&l.renderHyperlinkDetails?.(e,()=>t({showHyperlinkPopup:!1})),u?Pi("input"',
    );
  }
  writeFileSync(file, source + '\n// mervRichHyperlinkHook: pinned native popup extension\n');
}
const types = resolve(root, 'dist/types/excalidraw/types.d.ts');
let source = readFileSync(types, 'utf8');
if (!source.includes('renderHyperlinkDetails?:')) {
  source = source.replace(
    '    onLinkOpen?:',
    '    renderHyperlinkDetails?: (element: NonDeletedExcalidrawElement, close: () => void) => React.ReactNode;\n    onLinkOpen?:',
  );
  writeFileSync(types, source);
}
