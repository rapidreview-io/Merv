import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { mount, settle, unmount } from './ui-render';
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(name,ctx,next){if(ctx.parentURL?.includes('/views/board-shared.')){let s;if(name.endsWith('.css'))s='export{}';if(name==='@excalidraw/excalidraw')s='export const CaptureUpdateAction={NEVER:0};export const Excalidraw=()=>null;export const getDataURL=async b=>"data:"+await b.text();export const MainMenu=()=>null;export const WelcomeScreen=()=>null;';if(name==='./board-replay')s='export const BoardReplay=()=>null;';if(name==='./board-player')s='export const restored=x=>x;';if(name==='./board-fonts')s='export const ensureBoardFonts=(x)=>globalThis.sharedFonts(x);';if(s)return{url:'data:text/javascript,'+encodeURIComponent(s),shortCircuit:true}}return next(name,ctx)}`,
    ),
  import.meta.url,
);
const React = await import('react');
const { act, createElement: el } = React;
const { useSharedBoard } = await import('../packages/ui/web/views/board-shared');
const timers = new Map<number, () => void>();
let timer = 0;
const interval = globalThis.setInterval,
  clear = globalThis.clearInterval;
globalThis.setInterval = ((fn: any, ms: any, ...args: any[]) =>
  ms === 15000 ? (timers.set(++timer, fn), timer) : interval(fn, ms, ...args)) as any;
globalThis.clearInterval = ((id: any) => (timers.has(id) ? timers.delete(id) : clear(id))) as any;
after(() => {
  globalThis.setInterval = interval;
  globalThis.clearInterval = clear;
});
const file = 'a'.repeat(40);
const scene = (revision = 1, image = false) => ({
  title: 'Board',
  revision,
  elements: image ? [{ id: 'shape', type: 'image', fileId: file }] : [],
});
const json = (value: any) => new Response(JSON.stringify(value));
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function canvas() {
  const files: any = {},
    puts: any[] = [],
    added: any[] = [];
  let fits = 0;
  return {
    files,
    puts,
    added,
    get fits() {
      return fits;
    },
    getAppState: () => ({ isLoading: false }),
    getFiles: () => files,
    addFiles: (rows: any[]) => {
      added.push(rows);
      for (const row of rows) if (!files[row.id]) files[row.id] = row;
    },
    updateScene: (s: any) => puts.push(s),
    scrollToContent: () => fits++,
  };
}
async function finish(fn: () => void) {
  await act(async () => fn());
  await settle();
}
async function hook(t: any, fetcher: any, strict = false, fonts = async (_elements: any[]) => {}) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  (globalThis as any).sharedFonts = fonts;
  t.after(async () => {
    await unmount();
    globalThis.fetch = original;
  });
  let latest: any, changeToken: any, changeApi: any;
  const api = canvas();
  function Hook() {
    const [token, setToken] = React.useState('A');
    const [target, setTarget] = React.useState(api);
    changeToken = setToken;
    changeApi = setTarget;
    latest = useSharedBoard(token, target as any);
    return null;
  }
  await mount(strict ? el(React.StrictMode, null, el(Hook)) : el(Hook));
  await settle();
  return {
    api,
    get current() {
      return latest;
    },
    token: (s: string) => finish(() => changeToken(s)),
    replace: (a: any) => finish(() => changeApi(a)),
  };
}
test('token scope invalidates late images and fresh API receives new same-id bytes', async (t) => {
  const old = deferred<Response>();
  let images = 0;
  const h = await hook(t, (path: any, options: any) =>
    String(path).endsWith('/scene')
      ? Promise.resolve(json(scene(1, true)))
      : ++images === 1
        ? old.promise
        : Promise.resolve(new Response(options.headers.Authorization)),
  );
  await h.token('B');
  assert.equal(h.api.files[file].dataURL, 'data:Bearer B');
  await finish(() => old.resolve(new Response('OLD')));
  assert.equal(h.api.files[file].dataURL, 'data:Bearer B');
  // Consumers remount Excalidraw on a token change; its addFiles never replaces existing ids.
  await h.replace(null);
  await h.token('A');
  const next = canvas();
  await h.replace(next);
  assert.equal(next.files[file].dataURL, 'data:Bearer A');
  assert.equal(h.api.files[file].dataURL, 'data:Bearer B');
});

test('replay cleanup invalidates a pending history failure before it can restore an unmounted canvas', async () => {
  const source = readFileSync(
    new URL('../packages/ui/web/views/board-replay.tsx', import.meta.url),
    'utf8',
  );
  const ast = ts.createSourceFile(
    'board-replay.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const names = ['lift', 'putBack', 'refused', 'enter'],
    definitions: Record<string, string> = {};
  let cleanup = '';
  function visit(node: any) {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast)))
      definitions[node.name.getText(ast)] = node.initializer.getText(ast);
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === 'useEffect' &&
      node.arguments[0]?.getText(ast).includes('clearTimeout(ending.current)')
    )
      cleanup = node.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(cleanup);
  for (const name of names) assert.ok(definitions[name]);
  const pending = deferred<any>(),
    calls: any[] = [];
  const context = vm.createContext({
    live: {
      getAppState: () => ({ selectedElementIds: { s: true }, selectedGroupIds: {} }),
      getSceneElements: () => [{ id: 's' }],
      updateScene: (scene: any) => calls.push(scene),
    },
    selection: { current: null },
    CaptureUpdateAction: { NEVER: 0 },
    free: () => true,
    asked: { current: 0 },
    mode() {},
    setPhase() {},
    setScreen() {},
    say() {},
    settle: async () => {},
    readHistory: () => pending.promise,
    ending: { current: null },
    shown: { current: null },
    clearTimeout,
  });
  vm.runInContext(
    ts.transpile(
      names.map((name) => `const ${name}=${definitions[name]};`).join('\n') +
        `\nglobalThis.enter=enter;globalThis.cleanup=(${cleanup})();`,
      { target: ts.ScriptTarget.ES2022 },
    ),
    context,
  );
  const started = context.enter();
  await Promise.resolve();
  await Promise.resolve();
  const before = calls.length;
  context.cleanup();
  pending.reject(new Error('late history failure'));
  await started;
  assert.equal(calls.length, before);
  assert.equal(context.asked.current, 2);
});
