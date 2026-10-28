/**
 * Deliberate 0.18.1 integration hooks: the rich link popup, which also opens for a card drawn as a
 * group (its linked shape with its icon, fact and title), and a slot at the end of the shape
 * toolbar. Fail closed on dependency upgrades; no DOM injection.
 */
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
      !source.includes('max(16px, calc(100% - 396px))') ||
      !source.includes('mervCardOf')
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
      '      onLinkOpen,\n      renderHyperlinkDetails: props.renderHyperlinkDetails,\n      renderToolbarEnd: props.renderToolbarEnd,\n      generateLinkForSelection,',
    );
    replace(
      'selectedElements.length === 1 && this.state.openDialog?.name !== "elementLinkSelector" && this.state.showHyperlinkPopup && /* @__PURE__ */ jsx147(\n                          Hyperlink,\n                          {\n                            element: firstSelectedElement,',
      '(selectedElements.length === 1 || mervCardOf(selectedElements, this.props)) && this.state.openDialog?.name !== "elementLinkSelector" && this.state.showHyperlinkPopup && /* @__PURE__ */ jsx147(\n                          Hyperlink,\n                          {\n                            element: mervCardOf(selectedElements, this.props) ?? firstSelectedElement,',
    );
    replace(
      '                          UIOptions,\n                          app\n                        }\n                      )\n                    ] })',
      '                          UIOptions,\n                          app\n                        }\n                      ),\n                      app.props.renderToolbarEnd?.()\n                    ] })',
    );
    replace(
      '/* @__PURE__ */ jsx90(Stack_default.Row, { gap: 1, children: /* @__PURE__ */ jsx90(\n            ShapesSwitcher,',
      '/* @__PURE__ */ jsxs49(Stack_default.Row, { gap: 1, children: [/* @__PURE__ */ jsx90(\n            ShapesSwitcher,',
    );
    replace(
      '              app\n            }\n          ) })\n        ] }),\n        renderTopRightUI && renderTopRightUI(true, appState),',
      '              app\n            }\n          ), app.props.renderToolbarEnd?.()] })\n        ] }),\n        renderTopRightUI && renderTopRightUI(true, appState),',
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
      'onLinkOpen:S,renderHyperlinkDetails:e.renderHyperlinkDetails,renderToolbarEnd:e.renderToolbarEnd,generateLinkForSelection:I,onPointerDown:_,onPointerUp:k,onScrollChange:R,onDuplicate:M,validateEmbeddable:',
    );
    replace(
      't.length===1&&this.state.openDialog?.name!=="elementLinkSelector"&&this.state.showHyperlinkPopup&&Ie(vv,{element:m,',
      '(t.length===1||mervCardOf(t,this.props))&&this.state.openDialog?.name!=="elementLinkSelector"&&this.state.showHyperlinkPopup&&Ie(vv,{element:mervCardOf(t,this.props)??m,',
    );
    replace(
      'Z(Yc,{appState:o,activeTool:o.activeTool,UIOptions:p,app:b})]})]})',
      'Z(Yc,{appState:o,activeTool:o.activeTool,UIOptions:p,app:b}),b.props.renderToolbarEnd?.()]})]})',
    );
    replace(
      'dt(it.Row,{gap:1,children:dt(Yc,{appState:e,activeTool:e.activeTool,UIOptions:p,app:u})})',
      'ir(it.Row,{gap:1,children:[dt(Yc,{appState:e,activeTool:e.activeTool,UIOptions:p,app:u}),u.props.renderToolbarEnd?.()]})',
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
  writeFileSync(
    file,
    `${source}
// mervRichHyperlinkHook: pinned native popup extension
/** A card drawn as a group reads as its linked shape: every other part is a part in its group. */
function mervCardOf(elements, props) {
  const card = props.renderHyperlinkDetails && elements.length > 1 && elements.find((el) => el.link);
  return card &&
    elements.every((el) => el === card || (el.customData?.card && el.groupIds[0] === card.groupIds[0]))
    ? card
    : undefined;
}
`,
  );
}
const types = resolve(root, 'dist/types/excalidraw/types.d.ts');
let source = readFileSync(types, 'utf8');
if (!source.includes('renderToolbarEnd?:')) {
  source = source.replace(
    '    onLinkOpen?:',
    '    renderHyperlinkDetails?: (element: NonDeletedExcalidrawElement, close: () => void) => React.ReactNode;\n    renderToolbarEnd?: () => React.ReactNode;\n    onLinkOpen?:',
  );
  writeFileSync(types, source);
}
