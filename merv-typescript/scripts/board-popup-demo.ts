/** Local UI fixture: actual BoardCanvas + artifact renderer; in-memory API, no production data. */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Drawing } from '../packages/board/src/elements.js';
import { boardFontManifest } from './board-font-manifest.mjs';
const dir = mkdtempSync(join(tmpdir(), 'board-popup-demo-'));
const native = createRequire(import.meta.url).resolve('@excalidraw/excalidraw');
const fonts = boardFontManifest();
await build({
  stdin: {
    contents: `import React from 'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';import BoardCanvas from './packages/ui/web/views/board-canvas.tsx';import './packages/ui/web/styles.css';createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,null,React.createElement(BoardCanvas,{id:'board_demo'})));`,
    resolveDir: process.cwd(),
  },
  outfile: join(dir, 'demo.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' },
  conditions: ['production'],
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
  plugins: [
    {
      name: 'demo-context',
      setup(b) {
        b.onResolve({ filter: /^virtual:board-fonts$/ }, () => ({
          path: 'fonts',
          namespace: 'demo',
        }));
        b.onResolve({ filter: /^@excalidraw\/excalidraw$/ }, (a) =>
          a.importer.endsWith('board-canvas.tsx')
            ? { path: 'native', namespace: 'demo' }
            : undefined,
        );
        b.onResolve({ filter: /^(\.\.\/navigation|\.\.\/theme|\.\/pi-screen)$/ }, (a) =>
          a.importer.endsWith('board-canvas.tsx') ? { path: a.path, namespace: 'demo' } : undefined,
        );
        b.onLoad({ filter: /.*/, namespace: 'demo' }, ({ path }) => ({
          loader: 'js',
          resolveDir: process.cwd(),
          contents:
            path === 'fonts'
              ? 'export default ' +
                JSON.stringify(fonts.map(({ family, url, range }: any) => ({ family, url, range })))
              : path === 'native'
                ? `import React from'react';import*as N from ${JSON.stringify(native)};export*from ${JSON.stringify(native)};export const Excalidraw=p=>React.createElement(N.Excalidraw,{...p,excalidrawAPI:a=>{window.boardApi=a;p.excalidrawAPI(a)}});`
                : path === '../navigation'
                  ? 'export const useRows=()=>[];'
                  : path === '../theme'
                    ? `export const onWorn=()=>()=>{};export const worn=()=> 'light';`
                    : 'export const placeOf=async()=>"demo";',
        }));
      },
    },
  ],
  logLevel: 'warning',
});
const d = new Drawing([], true);
d.apply({ op: 'text', text: 'Research references · local popup preview', at: [80, 30], size: 'l' });
d.apply({
  op: 'text',
  text: 'Click a reference. Move your pointer away: it stays open.\nAll content below is labeled local fixture data.',
  at: [80, 95],
  size: 's',
});
const fixtures = [
  {
    text: 'Paper URL',
    at: [80, 240],
    target: 'https://transformer-circuits.pub/2022/toy_model/index.html',
    details: {
      title: 'Toy Models of Superposition',
      preview: {
        title: 'Toy Models of Superposition',
        description:
          'Local preview fixture · A controlled model of how neural networks represent more features than dimensions.',
      },
    },
  },
  {
    text: 'Notes + paper',
    at: [440, 240],
    target: 'https://transformer-circuits.pub/2023/monosemantic-features/index.html',
    details: {
      title: 'Towards Monosemanticity',
      text: 'Our reading notes — local fixture\n\nSparse dictionaries can separate interpretable features from mixed activations.\n\nQuestion: which recovered features remain useful under causal intervention?',
      preview: {
        title: 'Towards Monosemanticity',
        description:
          'Local preview fixture · Decomposing language models with dictionary learning.',
      },
    },
  },
  {
    text: 'Research artifact',
    at: [800, 240],
    target: 'artifact_popup_demo',
    details: { title: 'Research notes artifact', artifactId: 'artifact_popup_demo' },
  },
  { text: 'URL without metadata', at: [80, 650], target: 'https://example.com/research' },
];
for (const f of fixtures) d.apply({ op: 'link', ...f } as any);
let saved = [...d.elements.values()];
const content =
  '# Intervention checklist\n\nLocal artifact fixture rendered with Merv’s actual artifact viewer.\n\n| Test | What it establishes |\n| --- | --- |\n| Patch an activation | Sensitivity to a specific change |\n| Hold out prompts | Generalization beyond selected examples |\n| Compare controls | Whether a simpler intervention works |\n\n## Open question\nCan a feature improve a target behavior without disturbing unrelated capabilities?';
const artifact = {
  id: 'artifact_popup_demo',
  projectId: 'project_demo',
  createdBy: 'actor_demo',
  title: 'intervention-checklist.md',
  mediaType: 'text/markdown',
  hash: '0'.repeat(64),
  size: Buffer.byteLength(content),
  createdAt: '2026-10-19T12:00:00Z',
  downloadAvailable: false,
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, 'http://localhost');
    const font = fonts.find((f: any) => f.url === url.pathname);
    if (font) {
      res.setHeader('content-type', 'font/woff2');
      res.end(readFileSync(font.path));
      return;
    }
    if (url.pathname === '/demo.js' || url.pathname === '/demo.css') {
      res.setHeader('content-type', url.pathname.endsWith('js') ? 'text/javascript' : 'text/css');
      res.end(readFileSync(join(dir, url.pathname.slice(1))));
      return;
    }
    if (url.pathname.startsWith('/tools/')) {
      let body = '';
      for await (const c of req) body += c;
      const input = JSON.parse(body || '{}');
      const tool = url.pathname.slice(7);
      let result: any;
      if (tool === 'board.scene')
        result = { board: { id: 'board_demo', revision: 1 }, elements: input.since ? [] : saved };
      else if (tool === 'board.save') {
        for (const e of input.elements) {
          const i = saved.findIndex((x) => x.id === e.id);
          if (i < 0) saved.push(e);
          else saved[i] = e;
        }
        result = { accepted: input.elements.length };
      } else if (tool === 'artifact.get') result = artifact;
      else if (tool === 'artifact.read') result = { artifact, content, encoding: 'utf8' };
      else if (tool.endsWith('.list')) result = [];
      else result = {};
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ result }));
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>Local board popup examples</title><link rel="stylesheet" href="/demo.css"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}body{background:#fff}#root>div{height:100%}</style></head><body><div id="root"></div><script>sessionStorage.setItem('merv:token','local-demo-fixture');</script><script src="/demo.js"></script></body></html>`,
    );
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
  }
});
server.listen(4399, '127.0.0.1', () => console.log('Local popup demo: http://127.0.0.1:4399'));
