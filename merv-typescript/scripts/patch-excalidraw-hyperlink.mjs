/**
 * Deliberate 0.18.1 integration hooks: the rich link popup, placed at its card's corner for the
 * reader to move beside it, which also opens for a card drawn as a group (its linked shape with
 * its icon, fact and title); no link icon on a card that goes nowhere; and a slot at the end of
 * the shape toolbar. Fail closed on dependency upgrades; no DOM injection.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
      !source.includes('--card-width') ||
      !source.includes('mervLinkless') ||
      !source.includes('mervCardOf') ||
      !source.includes('mervImageBytes') ||
      !source.includes('mervLinkKeyless')
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
  // An image is refused past 10 MiB, Board's own limit, rather than Excalidraw's 4 MB. ⌘K is the
  // board's + panel (views/board-canvas.tsx), so nothing says it opens the link editor.
  if (mode === 'dev') {
    replace(
      't("labels.link.label")} - ${getShortcutKey("CtrlOrCmd+K")}`',
      't("labels.link.label")}`',
    );
    replace('hyperlink: [getShortcutKey("CtrlOrCmd+K")],', 'hyperlink: [/* mervLinkKeyless */],');
    replace(
      `/* @__PURE__ */ jsx92(
                  Shortcut,
                  {
                    label: t("toolBar.link"),
                    shortcuts: [getShortcutKey("CtrlOrCmd+K")]
                  }
                )`,
      '',
    );
    replace(
      'if (imageFile.size > MAX_ALLOWED_FILE_BYTES) {',
      'if (imageFile.size > 10485760 /* mervImageBytes */) {',
    );
    replace(
      'maxSize: `${Math.trunc(MAX_ALLOWED_FILE_BYTES / 1024 / 1024)}MB`',
      'maxSize: "10 MiB"',
    );
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
      'top: appProps.renderHyperlinkDetails ? `${y + 85}px` : `${y}px`,\n        left: appProps.renderHyperlinkDetails ? `${x + 190 - element.width * appState.zoom.value / 2}px` : `${x}px`,\n        "--card-width": `${element.width * appState.zoom.value}px`,\n        "--card-height": `${element.height * appState.zoom.value}px`,\n        width: POPUP_WIDTH,',
    );
    replace(
      'if (element.link && index >= hitElementIndex && isPointHittingLink(',
      'if (element.link && mervLinkShown(element) /* mervLinkless */ && index >= hitElementIndex && isPointHittingLink(',
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
    replace('g("labels.link.label")} - ${A("CtrlOrCmd+K")}`', 'g("labels.link.label")}`');
    replace('hyperlink:[A("CtrlOrCmd+K")],', 'hyperlink:[/* mervLinkKeyless */],');
    replace(',B(U,{label:g("toolBar.link"),shortcuts:[A("CtrlOrCmd+K")]})', '');
    replace('if(t.size>Zd)throw', 'if(t.size>10485760/* mervImageBytes */)throw');
    replace('maxSize:`${Math.trunc(Zd/1024/1024)}MB`', 'maxSize:"10 MiB"');
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
      'top:l.renderHyperlinkDetails?`${T+85}px`:`${T}px`,left:l.renderHyperlinkDetails?`${x+190-e.width*a.zoom.value/2}px`:`${x}px`,"--card-width":`${e.width*a.zoom.value}px`,"--card-height":`${e.height*a.zoom.value}px`,width:iu',
    );
    replace(
      'l.link&&a>=i&&Ts(l,this.scene.getNonDeletedElementsMap(),this.state',
      'l.link&&mervLinkShown(l)/* mervLinkless */&&a>=i&&Ts(l,this.scene.getNonDeletedElementsMap(),this.state',
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
/** A note goes nowhere and a card of several things to no one place: neither shows a link icon. */
function mervLinkShown(element) {
  return element.link !== 'merv:page' && !Array.isArray(element.customData?.target);
}
`,
  );
  // The link icon is drawn in the renderer's chunk, with no way to the helper above.
  const dir = resolve(root, `dist/${mode}`);
  const [before, after] =
    mode === 'dev'
      ? [
          'if (element.link && !appState.selectedElementIds[element.id]) {',
          'if (element.link && element.link !== "merv:page" /* mervLinkless */ && !Array.isArray(element.customData?.target) && !appState.selectedElementIds[element.id]) {',
        ]
      : [
          'if(e.link&&!n.selectedElementIds[e.id]){',
          'if(e.link&&e.link!=="merv:page"/* mervLinkless */&&!Array.isArray(e.customData?.target)&&!n.selectedElementIds[e.id]){',
        ];
  const chunks = readdirSync(dir).filter((name) => name.startsWith('chunk-'));
  if (chunks.some((name) => readFileSync(resolve(dir, name), 'utf8').includes(after))) continue;
  const chunk = chunks.find((name) => readFileSync(resolve(dir, name), 'utf8').includes(before));
  if (!chunk) throw new Error(`Excalidraw ${mode} link icon context changed`);
  const chunkFile = resolve(dir, chunk);
  writeFileSync(chunkFile, readFileSync(chunkFile, 'utf8').replace(before, after));
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
