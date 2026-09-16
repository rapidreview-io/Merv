import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { loadConfiguration } from '../src/config.js';
import { writeArchitectureExplorer } from './architecture-explorer.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const walk = (path: string): string[] =>
  readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(resolve(path, entry.name)) : [resolve(path, entry.name)],
  );
const config = JSON.parse(readFileSync(resolve(root, 'config/default.json'), 'utf8')) as {
  plugins: { id: string }[];
};
const configured = new Set(config.plugins.map((p) => p.id));
const plugins: {
  plugin: string;
  source: string;
  provides: string[];
  requires: string[];
  optional: string[];
  kind: string;
  runtime: 'server' | 'machine';
  defaultConfiguration: boolean;
}[] = [];
for (const file of walk(resolve(root, 'packages')).filter(
  (p) => p.includes('/src/') && p.endsWith('.ts') && !p.includes('/node_modules/'),
)) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const value = (name: string) => {
        const property = node.properties.find((p) => p.name?.getText(source) === name);
        return property && ts.isPropertyAssignment(property) ? property.initializer : undefined;
      };
      const name = value('name');
      if (
        name &&
        ts.isStringLiteral(name) &&
        name.text.startsWith('merv-') &&
        node.properties.some((p) => p.name?.getText(source) === 'apply')
      ) {
        const deps = value('inject');
        const requires =
          deps && ts.isArrayLiteralExpression(deps)
            ? deps.elements.map((e) => (e as ts.StringLiteral).text)
            : [];
        const provides: string[] = [];
        const optional: string[] = [];
        const find = (child: ts.Node) => {
          if (
            ts.isCallExpression(child) &&
            ts.isPropertyAccessExpression(child.expression) &&
            child.expression.name.text === 'inject' &&
            ts.isArrayLiteralExpression(child.arguments[0])
          )
            optional.push(...child.arguments[0].elements.map((e) => (e as ts.StringLiteral).text));
          if (
            ts.isCallExpression(child) &&
            ts.isPropertyAccessExpression(child.expression) &&
            child.expression.name.text === 'provide' &&
            ts.isStringLiteral(child.arguments[0])
          )
            provides.push(child.arguments[0].text);
          ts.forEachChild(child, find);
        };
        find(node);
        const sourcePath = relative(root, file),
          owner = sourcePath.split('/')[1];
        const kind = file.endsWith('/tools.ts')
          ? 'tools'
          : file.endsWith('/ui.ts')
            ? 'ui'
            : file.endsWith('/api.ts')
              ? 'api'
              : 'service';
        const id =
          kind === 'service'
            ? provides[0]?.replace(/[A-Z]/g, (l) => '-' + l.toLowerCase())
            : `${owner}-${kind}`;
        plugins.push({
          plugin: name.text,
          source: sourcePath,
          provides,
          requires,
          optional,
          kind,
          runtime: name.text === 'merv-runner' ? 'machine' : 'server',
          defaultConfiguration: configured.has(id),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
plugins.sort((a, b) => a.plugin.localeCompare(b.plugin));
const providers = plugins.filter((p) => p.provides.length);
const directConsumers = Object.fromEntries(
  providers
    .flatMap((p) => p.provides)
    .map((name) => [
      name,
      plugins.filter((p) => [...p.requires, ...p.optional].includes(name)).length,
    ]),
);
const data = {
  snapshot: new Date().toISOString().slice(0, 10),
  definition:
    'Requires: mandatory Cordis injection. Optional: child injection that may be absent without stopping the provider. Not a call graph or remote-health guarantee.',
  pluginCount: plugins.length,
  serviceProviders: providers.length,
  toolAdapters: plugins.filter((p) => p.kind === 'tools').length,
  uiAdapters: plugins.filter((p) => p.kind === 'ui').length,
  apiAdapters: plugins.filter((p) => p.kind === 'api').length,
  defaultEntries: config.plugins.length,
  apiEntries: loadConfiguration({ directory: root, api: true }).entries.length,
  serverPlugins: plugins.filter((p) => p.runtime === 'server').length,
  machinePlugins: plugins.filter((p) => p.runtime === 'machine').length,
  directDependencyCount: plugins.reduce((n, p) => n + p.requires.length + p.optional.length, 0),
  optionalDependencyCount: plugins.reduce((n, p) => n + p.optional.length, 0),
  directConsumers,
  plugins,
  externalServices: ['Nisa MCP via Mounts', 'Sandboxes MCP via Mounts'],
  connections: [
    {
      from: 'runner',
      to: 'api',
      protocol: 'HTTP',
      cordisDependency: false,
      description:
        'The independent machine Runner calls session controls and fixed Code command controls over HTTP.',
    },
  ],
  scope:
    'Current working-tree declarations. The Runner plugin runs in a separate machine context; it is not part of server composition. See verification records for tested behavior.',
};
writeFileSync(
  resolve(root, 'docs/architecture/current-dependencies.json'),
  JSON.stringify(data, null, 2) + '\n',
);
const id = (name: string) => name.replaceAll('-', '_');
let graph = 'flowchart BT\n';
for (const runtime of ['server', 'machine'] as const) {
  graph += `  subgraph ${runtime}["${runtime === 'server' ? 'Merv server' : 'Independent machine runtime'}"]\n`;
  for (const plugin of plugins.filter((p) => p.runtime === runtime)) {
    const key = plugin.provides[0] ?? plugin.plugin;
    graph += `    ${id(key)}["${key}"]\n`;
  }
  graph += '  end\n';
}
for (const plugin of plugins) {
  const key = plugin.provides[0] ?? plugin.plugin;
  for (const dep of plugin.requires) graph += `  ${id(key)} --> ${id(dep)}\n`;
  for (const dep of plugin.optional) graph += `  ${id(key)} -. optional .-> ${id(dep)}\n`;
}
graph += '  runner -. "HTTP session and Code controls; not a Cordis dependency" .-> api\n';
writeFileSync(resolve(root, 'docs/architecture/current-dependencies.mmd'), graph);
writeArchitectureExplorer(root, data);
console.log(
  JSON.stringify({
    plugins: data.pluginCount,
    providers: data.serviceProviders,
    tools: data.toolAdapters,
    ui: data.uiAdapters,
    api: data.apiAdapters,
    dependencies: data.directDependencyCount,
    defaultEntries: data.defaultEntries,
    apiEntries: data.apiEntries,
    serverPlugins: data.serverPlugins,
    machinePlugins: data.machinePlugins,
  }),
);
