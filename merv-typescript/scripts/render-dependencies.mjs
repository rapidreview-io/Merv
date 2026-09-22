import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Use the bundled renderer dependencies, or an explicitly supplied node_modules directory.
const modules =
  process.env.MERV_RENDER_NODE_MODULES ??
  join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const require = createRequire(resolve(modules, '../package.json'));
const { instance } = await import(pathToFileURL(require.resolve('@viz-js/viz')).href);
const sharp = require('sharp');
const directory = fileURLToPath(new URL('../docs/architecture/', import.meta.url));
const data = JSON.parse(readFileSync(directory + 'current-dependencies.json', 'utf8'));
const viz = await instance();
const adapterExtraHeight =
  Math.max(0, Math.ceil((data.toolAdapters + data.uiAdapters) / 3) - 5) * 125;
const researchPanelHeight = 900;
const canvasHeight = 3380 + adapterExtraHeight + researchPanelHeight;
const serverProviders = data.plugins.filter(
  (p) => p.runtime === 'server' && p.provides.length,
).length;
const machineProviders = data.plugins.filter(
  (p) => p.runtime === 'machine' && p.provides.length,
).length;
const names = {
  state: 'State',
  blobs: 'Blobs',
  scope: 'Scope',
  artifacts: 'Artifacts',
  workflows: 'Workflows',
  reviews: 'Reviews',
  tasks: 'Tasks',
  feed: 'Feed',
  domainEvents: 'Domain Events',
  contextBuilder: 'Context Builder',
  tools: 'Tools',
  api: 'API',
  identity: 'Identity',
  mounts: 'External Mounts',
  ui: 'UI',
  sessions: 'Agent Sessions',
  runner: 'Runner',
  code: 'Code',
  experiments: 'Experiments',
  knowledge: 'Knowledge',
  paper: 'Paper',
  reflections: 'Reflections',
  research: 'Research',
};
const nodes = new Set(),
  edges = [],
  optionalEdges = [],
  httpEdges = [];
function panel(name, x, y, width, height) {
  const dot = readFileSync(directory + name + '-dependencies.dot', 'utf8');
  for (const match of dot.matchAll(/^(\w+) \[id="node-/gm)) nodes.add(match[1]);
  const panelEdges = [...dot.matchAll(/^(\w+) -> (\w+) \[([^\n]+)\];/gm)].map((m) => [
    m[1],
    m[2],
    m[3],
  ]);
  const http = [...dot.matchAll(/^(\w+) -> (\w+) \[id="http-/gm)].map((m) => `${m[1]}->${m[2]}`);
  httpEdges.push(...http);
  edges.push(
    ...panelEdges
      .filter(([from, to]) => !http.includes(`${from}->${to}`))
      .map(
        ([from, to]) =>
          `${from === 'sessionsApi' ? 'merv-sessions-api' : from === 'codeApi' ? 'merv-code-api' : from}->${to}`,
      ),
  );
  optionalEdges.push(
    ...panelEdges
      .filter(([, , attributes]) => /\bstyle="dashed"/.test(attributes))
      .map(([from, to]) => `${from}->${to}`),
  );
  let svg = viz.renderString(dot, { format: 'svg', engine: 'dot' });
  for (const [from, to] of panelEdges) {
    const kind = http.includes(`${from}->${to}`) ? 'http' : 'edge';
    assert.ok(svg.replaceAll('&#45;', '-').includes(`id="${kind}-${from}-${to}"`));
  }
  return svg
    .slice(svg.indexOf('<svg'))
    .replace(
      /<svg[^>]*viewBox="([^"]+)"[^>]*>/,
      `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="$1" preserveAspectRatio="xMidYMid meet">`,
    )
    .replaceAll('id="', `id="${name}-`)
    .trimEnd();
}
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2800" height="${canvasHeight}" viewBox="0 0 2800 ${canvasHeight}"><rect width="100%" height="100%" fill="#F8FAFD"/><style>text{font-family:Arial,Helvetica,sans-serif;fill:#102438}.title{font-size:58px;font-weight:700}.section{font-size:34px;font-weight:700}.body{font-size:27px}.small{font-size:23px}</style><text x="80" y="92" class="title">Merv · Cordis plugin dependencies</text><text x="80" y="142" class="body">Current code · ${data.snapshot} · ${data.pluginCount} plugins · ${data.directDependencyCount - data.optionalDependencyCount} required + ${data.optionalDependencyCount} optional dependencies · ${data.connections.length} shown HTTP connection</text><rect x="80" y="174" width="2640" height="74" rx="14" fill="#E8EFFB"/><text x="110" y="222" class="body"><tspan font-weight="700">A → B points to a used service.</tspan> Solid: required. Dashed: optional. Dotted: HTTP requests.</text><rect x="60" y="284" width="1320" height="1190" rx="24" fill="white" stroke="#C7D9E9" stroke-width="2"/><rect x="1410" y="284" width="1330" height="1190" rx="24" fill="white" stroke="#D9D0EF" stroke-width="2"/><text x="95" y="341" class="section">Domain plugins</text><text x="1445" y="341" class="section">Transport + connection plugins</text>`;
svg += panel('domain', 80, 375, 1280, 1060) + panel('transport', 1430, 385, 1290, 960);
svg +=
  '<text x="1455" y="1384" class="small">External Mounts connects to external Nisa and Sandboxes MCP.</text><text x="1455" y="1424" class="small">Remote service health is handled by the integration.</text>';
svg +=
  '<rect x="60" y="1504" width="2680" height="870" rx="24" fill="white" stroke="#D9D0EF" stroke-width="2"/><text x="95" y="1562" class="section">Research programs + living paper</text><text x="95" y="1605" class="small">Separate workflow programs. Shared-provider references name the same services in the other panels.</text>';
svg += panel('research', 100, 1640, 2600, 710);
svg += `<g transform="translate(0, ${researchPanelHeight})">`;
svg +=
  '<rect x="60" y="1504" width="2680" height="480" rx="24" fill="white" stroke="#C1DFD8" stroke-width="2"/><text x="95" y="1562" class="section">Agent Sessions, Code + HTTP adapters</text><text x="95" y="1605" class="small">Reference blocks name the same providers above. Code requests commits through Runner; Agent Sessions uses domain program hooks.</text>';
svg += panel('session', 100, 1640, 2600, 325);
svg +=
  '<rect x="60" y="2014" width="2680" height="360" rx="24" fill="#FFFCF7" stroke="#D8BD9B" stroke-width="2"/><text x="95" y="2072" class="section">Independent machine plugin</text><text x="95" y="2115" class="small">Runner has its own Cordis context and local ledger. It does not inject any server provider.</text>';
svg += panel('machine', 120, 2145, 2560, 215);
svg += `<rect x="60" y="2404" width="2680" height="${790 + adapterExtraHeight}" rx="24" fill="white" stroke="#CDDCE7" stroke-width="2"/><text x="95" y="2462" class="section">Tool and UI adapter plugins</text><text x="95" y="2505" class="small">Each row is one plugin; Requires lists every direct dependency. Both HTTP adapters are drawn in the panel above.</text>`;
const adapters = data.plugins
  .filter((p) => p.kind === 'tools' || p.kind === 'ui')
  .sort((a, b) => a.kind.localeCompare(b.kind) || a.plugin.localeCompare(b.plugin));
assert.equal(adapters.length, data.toolAdapters + data.uiAdapters);
for (const [i, p] of adapters.entries()) {
  const x = 95 + (i % 3) * 890,
    y = 2540 + Math.floor(i / 3) * 125;
  const requires = p.requires
    .map((d) => {
      assert.ok(names[d]);
      return names[d];
    })
    .join(' + ');
  const optional = p.optional
    .map((d) => {
      assert.ok(names[d]);
      return names[d];
    })
    .join(' + ');
  svg += `<rect x="${x}" y="${y}" width="840" height="103" rx="12" fill="#F3F6FC"/><text x="${x + 22}" y="${y + 37}" class="body" font-weight="700">${p.plugin.replace(/^merv-/, '')}${p.defaultConfiguration ? '' : ' · optional'}</text><text x="${x + 22}" y="${y + 77}" class="small">Requires: ${requires}${optional ? ` · Optional: ${optional}` : ''}</text>`;
  edges.push(...[...p.requires, ...p.optional].map((d) => `${p.plugin}->${d}`));
  optionalEdges.push(...p.optional.map((d) => `${p.plugin}->${d}`));
}
svg += `<text x="80" y="${3260 + adapterExtraHeight}" class="small"><tspan font-weight="700">Runtime:</tspan> Removing a required provider suspends its dependents. Optional providers can be absent without stopping the plugin.</text><text x="80" y="${3302 + adapterExtraHeight}" class="small"><tspan font-weight="700">Composition:</tspan> server default: ${data.defaultEntries} entries; API-only: ${data.apiEntries}. Runner is a separate machine runtime; External Mounts remains optional.</text><text x="80" y="${3341 + adapterExtraHeight}" font-size="19">${data.serviceProviders} providers (${serverProviders} server + ${machineProviders} machine) + ${data.toolAdapters} tool adapters + ${data.uiAdapters} UI adapters + ${data.apiAdapters} API adapters · ${data.pluginCount} plugin entrypoints</text></g></svg>`;
const expectedNodes = data.plugins.flatMap((p) => p.provides);
assert.deepEqual(
  [...nodes].filter((n) => !['sessionsApi', 'codeApi'].includes(n)).sort(),
  expectedNodes.sort(),
);
assert.ok(nodes.has('sessionsApi') && nodes.has('codeApi'));
const expectedEdges = data.plugins.flatMap((p) =>
  [...p.requires, ...p.optional].map((d) => `${p.provides[0] ?? p.plugin}->${d}`),
);
const expectedOptionalEdges = data.plugins.flatMap((p) =>
  p.optional.map((d) => `${p.provides[0] ?? p.plugin}->${d}`),
);
assert.deepEqual(edges.sort(), expectedEdges.sort());
assert.deepEqual(optionalEdges.sort(), expectedOptionalEdges.sort());
assert.equal(new Set(edges).size, edges.length);
assert.equal(edges.length, data.directDependencyCount);
assert.equal(optionalEdges.length, data.optionalDependencyCount);
assert.deepEqual(
  httpEdges,
  data.connections.filter((c) => !c.cordisDependency).map((c) => `${c.from}->${c.to}`),
);
const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
assert.equal(new Set(ids).size, ids.length);
writeFileSync(directory + 'current-dependencies.svg', svg);
await sharp(Buffer.from(svg))
  .png()
  .toFile(directory + 'current-dependencies.png');
console.log(
  JSON.stringify({
    plugins: data.pluginCount,
    providers: expectedNodes.length,
    toolAdapters: adapters.filter((p) => p.kind === 'tools').length,
    uiAdapters: adapters.filter((p) => p.kind === 'ui').length,
    apiAdapters: data.apiAdapters,
    directDependencies: edges.length,
    requiredDependencies: edges.length - optionalEdges.length,
    optionalDependencies: optionalEdges.length,
    drawnArrowEdges:
      edges.length - adapters.reduce((n, p) => n + p.requires.length + p.optional.length, 0),
    adapterRowEdges: adapters.reduce((n, p) => n + p.requires.length + p.optional.length, 0),
    defaultEntries: data.defaultEntries,
    apiEntries: data.apiEntries,
    width: 2800,
    height: canvasHeight,
    httpConnections: httpEdges.length,
  }),
);
