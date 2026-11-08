import './ui-render.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { createElement } from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
// Canvas layout is external; the view lifecycle and API scope/response handling run unchanged.
const stubs: Record<string, string> = {
  '@excalidraw/excalidraw': `import React from 'react'; const Null=()=>null; export const MainMenu=Object.assign(Null,{DefaultItems:{SaveAsImage:Null,ChangeCanvasBackground:Null,Help:Null}}); export const WelcomeScreen=Object.assign(Null,{Center:Object.assign(Null,{Heading:Null}),Hints:{ToolbarHint:Null}}); export const Excalidraw=props=>{globalThis.canvasProps=props;return React.createElement('div',{className:'excalidraw'});}; export const getDataURL=async()=>'';export const CaptureUpdateAction={NEVER:'never'};export const getCommonBounds=()=>[0,0,0,0];export const newElementWith=(a,b)=>({...a,...b});export const restoreElements=a=>a;`,
  'react-router-dom': `export const useNavigate=()=>()=>{};export const useSearchParams=()=>[new URLSearchParams()];`,
  './board-replay': `export const BoardReplay=()=>null;`,
  './board-fonts': `export const ensureBoardFonts=async()=>{};`,
  './board-player': `export const restored=a=>a;export const fileOf=e=>e.fileId??null;export const imageAt=id=>'/board/images/'+id;export const fitView=()=>{};export const imageBringer=()=>()=>{};export class Player{};export const stageOf=()=>({});`,
  '../list-filters': `export const typing=()=>false;`,
  '../navigation': `export const useRows=()=>[];`,
  '../theme': `export const onWorn=()=>()=>{};export const worn=()=> 'light';`,
  './pi-screen': `export const placeOf=async()=>null;`,
  './pi-transport': `export const pointWith=()=>()=>{};`,
  './board-link-details': `export const BoardLinkDetails=()=>null;export const PAGE_LINK='page';`,
  './board-add': `export const AddButton=()=>null;export const asksToAdd=()=>()=>{};export const CardPicker=()=>null;`,
  './board-place': `export const inView=()=>{};export const landing=()=>{};export const overlaps=()=>false;`,
  './board-follow': `export class BoardFollow{}`,
  './board-pointing': `export class BoardPointing{};export const markOn=()=>null;`,
  './board-presence': `export class BoardPresence{}`,
  './board-selection': `export const BoardSelection=()=>null;`,
  './board-talk': `export const BoardTalk=()=>null;`,
  './pi': `export const useAgent=()=>null;`,
};

const bundle = await build({
  stdin: {
    contents: `export {default as SharedBoard} from './packages/ui/web/views/board-shared.tsx';export {default as BoardCanvas} from './packages/ui/web/views/board-canvas.tsx';export * as api from './packages/ui/web/api.ts';`,
    resolveDir: root,
    loader: 'tsx',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  write: false,
  plugins: [
    {
      name: 'canvas-boundary',
      setup(b) {
        b.onResolve({ filter: /.*/ }, (a) => {
          if (a.path.endsWith('.css')) return { path: a.path, namespace: 'empty' };
          if (stubs[a.path]) return { path: a.path, namespace: 'stub' };
          if (a.path === 'react' || a.path === 'react/jsx-runtime')
            return { path: pathToFileURL(require.resolve(a.path)).href, external: true };
        });
        b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: '', loader: 'js' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
          contents: stubs[a.path],
          loader: 'js',
          resolveDir: root,
        }));
      },
    },
  ],
});
const { SharedBoard, BoardCanvas, api } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString('base64')}`
);
const canvas = globalThis as unknown as {
  canvasProps: { onChange: (elements: unknown[], state: unknown, files: unknown) => void };
};

test('shared board recovers when a failed poll succeeds without a page reload', async (t) => {
  const host = document.createElement('div');
  document.body.append(host);
  const rendered = createRoot(host);
  t.after(async () => {
    await act(async () => rendered.unmount());
    host.remove();
  });
  let poll: () => void = () => assert.fail('missing poll');
  t.mock.method(globalThis, 'setInterval', (fn: () => void) => {
    poll = fn;
    return 1;
  });
  t.mock.method(globalThis, 'clearInterval', () => {});
  let gets = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    ++gets === 1
      ? new Response('', { status: 503 })
      : Response.json({ title: 'Recovered board', revision: 1, elements: [] }),
  );
  await act(async () => rendered.render(createElement(SharedBoard)));
  assert.match(host.textContent!, /unavailable/);
  await act(async () => {
    poll();
    await new Promise((r) => setTimeout(r, 0));
  });
  assert.equal(gets, 2);
  assert.match(host.textContent!, /Recovered board/);
  assert.doesNotMatch(host.textContent!, /unavailable/);
});

test('queued board writes stay with their original account and project', async (t) => {
  for (const change of ['none', 'project', 'account'] as const) {
    const requests: { path: string; headers: Headers; body: unknown }[] = [];
    api.setToken('fixture-account');
    api.setProject('project-a');
    t.mock.method(globalThis, 'fetch', async (path: string, init?: RequestInit) => {
      requests.push({ path, headers: new Headers(init?.headers), body: init?.body });
      return Response.json(
        path === '/tools/board.scene'
          ? { result: { board: { revision: 0 }, elements: [], outcomes: [] } }
          : { result: {} },
      );
    });
    const host = document.createElement('div');
    document.body.append(host);
    const rendered = createRoot(host);
    await act(async () => rendered.render(createElement(BoardCanvas, { id: 'board-a' })));
    await act(async () =>
      canvas.canvasProps.onChange(
        [
          {
            id: 'picture',
            type: 'image',
            fileId: 'image-a',
            version: 1,
            width: 100,
            groupIds: [],
            isDeleted: false,
          },
        ],
        { zoom: { value: 1 }, selectedElementIds: {} },
        { 'image-a': { dataURL: 'data:image/png;base64,RklYVFVSRQ==' } },
      ),
    );
    await act(async () => {
      if (change === 'project') api.setProject('project-b');
      if (change === 'account') {
        api.setToken('other-account');
        api.setProject('project-a');
      }
      rendered.unmount();
    });
    const put = requests.find((r) => r.path === '/board/images/image-a');
    assert.equal(!!put, change === 'none', 'only the unchanged scope may flush');
    if (put) {
      assert.equal(put.headers.get('x-merv-project-id'), 'project-a');
      assert.equal(Buffer.from(put.body as Uint8Array).toString(), 'FIXTURE');
    }
    assert.equal(
      requests.some((r) => r.path === '/tools/board.save'),
      change === 'none',
    );
    host.remove();
    t.mock.restoreAll();
  }
});
