import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

interface InventoryPlugin {
  plugin: string;
  source: string;
  provides: string[];
  requires: string[];
  optional: string[];
  kind: string;
  runtime: string;
  defaultConfiguration: boolean;
}
interface Inventory {
  snapshot: string;
  plugins: InventoryPlugin[];
  pluginCount: number;
  serviceProviders: number;
  directDependencyCount: number;
}

/** Extract literal native tool declarations; never run plugins or read runtime credentials. */
function sourceTools(root: string, file: string) {
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve(root, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const tools = new Map<string, { name: string; description: string; readOnly: boolean }>();
  const literal = (value?: ts.Node) =>
    value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
      ? value.text
      : '';
  const add = (name: string, description: string, readOnly: boolean) => {
    if (/^[a-z_][a-z0-9_]*\.[a-z0-9_.]+$/.test(name))
      tools.set(name, { name, description, readOnly });
  };
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const prop = (name: string) => {
        const p = node.properties.find((p) => p.name?.getText(source) === name);
        return p && ts.isPropertyAssignment(p) ? p.initializer : undefined;
      };
      add(
        literal(prop('name')),
        literal(prop('description')),
        prop('readOnly')?.kind === ts.SyntaxKind.TrueKeyword,
      );
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'register'
    )
      add(
        literal(node.arguments[0]),
        literal(node.arguments[1]),
        node.arguments[4]?.kind === ts.SyntaxKind.TrueKeyword,
      );
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...tools.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function writeArchitectureExplorer(root: string, inventory: Inventory): void {
  const directory = resolve(root, 'docs/architecture/explorer');
  const notes = JSON.parse(readFileSync(resolve(directory, 'notes.json'), 'utf8')) as {
    groups: {
      id: string;
      label: string;
      caption: string;
      members: string[];
      description: string;
    }[];
    plugins: Record<string, { label: string; purpose: string }>;
  };
  const providers = new Map(
    inventory.plugins.flatMap((p) => p.provides.map((id) => [id, p] as const)),
  );
  const owner = (p: InventoryPlugin) =>
    [...providers].find(
      ([, provider]) => provider.source.split('/')[1] === p.source.split('/')[1],
    )?.[0];
  const nodes = inventory.plugins.map((p) => {
    const id = p.provides[0] ?? p.plugin;
    const parent = p.kind === 'service' ? id : owner(p);
    const group =
      p.kind === 'service'
        ? (notes.groups.find((group) => group.members.includes(id))?.id ?? 'other')
        : 'front';
    const ownTools = p.kind === 'tools' || id === 'ui' ? sourceTools(root, p.source) : [];
    return {
      ...p,
      id,
      group,
      owner: parent,
      label:
        notes.plugins[id]?.label ??
        (p.kind !== 'service'
          ? `${notes.plugins[parent ?? '']?.label ?? parent ?? p.plugin} · ${p.kind} adapter`
          : id),
      purpose:
        notes.plugins[id]?.purpose ??
        (p.kind !== 'service'
          ? `Connects ${notes.plugins[parent ?? '']?.label ?? parent} to the ${p.kind === 'tools' ? 'Tools' : p.kind === 'ui' ? 'UI' : 'API'} registry. This adapter owns no domain state.`
          : 'New provider discovered in source; add its explanatory note in explorer/notes.json.'),
      exposedTools: ownTools,
    };
  });
  for (const node of nodes.filter((node) => node.kind === 'service')) {
    const definitions = nodes
      .filter((adapter) => adapter.kind === 'tools' && adapter.owner === node.id)
      .flatMap((adapter) => adapter.exposedTools);
    node.exposedTools = [...node.exposedTools, ...definitions];
  }
  if (nodes.some((node) => node.group === 'other'))
    notes.groups.push({
      id: 'other',
      label: 'New providers',
      caption: 'Discovered in source',
      members: nodes.filter((node) => node.group === 'other').map((node) => node.id),
      description:
        'These providers were discovered automatically and await a visual grouping in notes.json.',
    });
  const edges = nodes.flatMap((node) =>
    [...node.requires, ...node.optional].map((dependency) => {
      if (!providers.has(dependency))
        throw new Error(`${node.id} requires missing provider ${dependency}`);
      return { from: node.id, to: dependency, optional: node.optional.includes(dependency) };
    }),
  );
  if (edges.length !== inventory.directDependencyCount)
    throw new Error('Dependency inventory is inconsistent');
  const data = {
    snapshot: inventory.snapshot,
    groups: notes.groups,
    nodes,
    edges,
    counts: {
      plugins: nodes.length,
      providers: providers.size,
      adapters: nodes.length - providers.size,
      dependencies: edges.length,
    },
    network: [
      {
        from: 'sandboxes',
        to: 'remote-sandboxes',
        protocol: 'HTTP',
        description:
          'Optional direct compute-service connection for published views, scoped reads and lease controls.',
      },
      {
        from: 'runner',
        to: 'api',
        protocol: 'HTTP',
        description: 'Authenticated Sessions and Code controls. Not a Cordis inject dependency.',
      },
      {
        from: 'mounts',
        to: 'remote-nisa',
        protocol: 'MCP',
        description: 'Optional Nisa MCP connection; configured separately.',
      },
      {
        from: 'mounts',
        to: 'remote-sandboxes',
        protocol: 'MCP',
        description: 'Optional Sandboxes MCP connection; configured separately.',
      },
    ],
  };
  const template = readFileSync(resolve(directory, 'shell.html'), 'utf8');
  const html = template
    .replace('/* EXPLORER_CSS */', () => readFileSync(resolve(directory, 'style.css'), 'utf8'))
    .replace('/* EXPLORER_DATA */', () => JSON.stringify(data).replaceAll('<', '\\u003c'))
    .replace('/* EXPLORER_JS */', () =>
      ['dag.js', 'app.js'].map((file) => readFileSync(resolve(directory, file), 'utf8')).join('\n'),
    );
  writeFileSync(resolve(directory, 'index.html'), html);
  writeFileSync(resolve(directory, 'data.json'), JSON.stringify(data, null, 2) + '\n');
}
