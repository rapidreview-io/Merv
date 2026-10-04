import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

/**
 * Compiles the plugin atlas from source: each package's service contracts (read through the
 * type checker), which neighbour calls which method, native tools, domain events, owned tables
 * and the SQL that reaches into another package's tables. Nothing here runs a plugin.
 */
interface InventoryPlugin {
  plugin: string;
  source: string;
  provides: string[];
  requires: string[];
  optional: string[];
  kind: string;
  runtime: string;
}
interface Inventory {
  snapshot: string;
  plugins: InventoryPlugin[];
  connections: { from: string; to: string; protocol: string }[];
}
interface Param {
  name: string;
  type: string;
  optional?: true;
}
interface Member {
  name: string;
  kind: 'method' | 'value';
  params: Param[];
  returns: string;
  hook?: true;
  tx?: 'required' | 'optional';
  caller?: true;
  doc?: string;
}
type Sites = { count: number; sites: string[] };

const EVENT = /^[a-z][a-z_]*\.[a-z_]+(?:\.[a-z_]+)*$/;
const TOOL = /^[a-z_][a-z0-9_]*\.[a-z0-9_.]+$/;
const CONTEXT_TYPES = new Set(['Transaction', 'Caller', 'Sql']);
const EMITTERS = /^(?:recorded|record[A-Z]\w*|appendEvent|emit\w*|event)$/;

const walk = (path: string): string[] =>
  existsSync(path)
    ? readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(resolve(path, entry.name)) : [resolve(path, entry.name)],
      )
    : [];
const clip = (text: string, max: number) =>
  text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
const sortKeys = <T>(record: Record<string, T>) =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

/** Exported workflow graphs, read by importing the modules that declare them. */
async function stateMachines(root: string, files: string[]) {
  const found: {
    owner: string;
    exportName: string;
    name: string;
    version: number;
    initial: string;
    states: string[];
    terminal: string[];
    edges: { from: string; action: string; to: string }[];
  }[] = [];
  for (const file of files) {
    if (!/export const \w+: WorkflowDefinition\b/.test(readFileSync(file, 'utf8'))) continue;
    const module = (await import(file)) as Record<string, unknown>;
    for (const [exportName, value] of Object.entries(module)) {
      const v = value as {
        name?: unknown;
        version?: unknown;
        initial?: unknown;
        states?: unknown;
        terminal?: unknown;
        edges?: unknown;
      };
      if (
        !v ||
        typeof v !== 'object' ||
        typeof v.name !== 'string' ||
        typeof v.version !== 'number' ||
        !Array.isArray(v.edges) ||
        !Array.isArray(v.states)
      )
        continue;
      found.push({
        owner: relative(root, file).split('/')[1],
        exportName,
        name: v.name,
        version: v.version,
        initial: String(v.initial),
        states: v.states as string[],
        terminal: (v.terminal as string[]) ?? [],
        edges: (v.edges as { from: string; action: string; to: string }[]).map(
          ({ from, action, to }) => ({ from, action, to }),
        ),
      });
    }
  }
  const latest = new Map<string, number>();
  for (const graph of found)
    latest.set(graph.name, Math.max(latest.get(graph.name) ?? 0, graph.version));
  const seen = new Set<string>();
  return found
    .filter((graph) => graph.version === latest.get(graph.name))
    .filter((graph) => {
      const key = graph.name + JSON.stringify(graph.edges);
      return !seen.has(key) && !!seen.add(key);
    })
    .sort((a, b) =>
      `${a.owner}${a.name}${a.exportName}`.localeCompare(`${b.owner}${b.name}${b.exportName}`),
    );
}

export async function compileAtlas(root: string, inventory: Inventory) {
  const packages = readdirSync(resolve(root, 'packages')).filter((name) =>
    existsSync(resolve(root, 'packages', name, 'package.json')),
  );
  const pkgOf = (file: string) => relative(root, file).split('/')[1];
  const rel = (file: string) => relative(root, file);
  const serverFiles = packages
    .flatMap((name) => walk(resolve(root, 'packages', name, 'src')))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .sort();
  const webFiles = packages
    .flatMap((name) => walk(resolve(root, 'packages', name, 'web')))
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith('.d.ts'))
    .sort();

  const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
  const program = ts.createProgram(serverFiles, { ...options, noEmit: true });
  const checker = program.getTypeChecker();
  const sources = serverFiles.map((file) => program.getSourceFile(file)!).filter(Boolean);

  const providerOf = new Map<string, string>();
  for (const plugin of inventory.plugins)
    for (const key of plugin.provides) providerOf.set(key, plugin.source.split('/')[1]);

  /* ---------- services: Cordis Context declarations, read as types ---------- */
  const services = new Map<
    string,
    { key: string; provider: string; type: string; symbol: ts.Symbol; members: Member[] }
  >();
  const symbolOf = (type: ts.Type): ts.Symbol | undefined => {
    if (type.aliasSymbol && ['Pick', 'Omit', 'Partial', 'Readonly'].includes(type.aliasSymbol.name))
      return type.aliasTypeArguments?.[0]?.getSymbol();
    return type.getSymbol() ?? type.aliasSymbol;
  };
  const typeName = (type: ts.Type) => symbolOf(checker.getNonNullableType(type))?.name ?? '';
  const callable = (type: ts.Type, depth = 0): boolean => {
    const t = checker.getNonNullableType(type);
    if (CONTEXT_TYPES.has(typeName(t)) || checker.isArrayType(t) || checker.isTupleType(t))
      return false;
    if (t.getCallSignatures().length) return true;
    if (t.isUnion()) return t.types.some((u) => callable(u, depth));
    if (depth > 0 || !(t.flags & ts.TypeFlags.Object)) return false;
    return checker.getPropertiesOfType(t).some((p) => {
      const decl = p.valueDeclaration ?? p.declarations?.[0];
      return decl ? callable(checker.getTypeOfSymbolAtLocation(p, decl), depth + 1) : false;
    });
  };
  const show = (type: ts.Type) =>
    clip(checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation), 90);
  const membersOf = (type: ts.Type): Member[] =>
    checker
      .getPropertiesOfType(type)
      .map((prop): Member => {
        const decl = prop.valueDeclaration ?? prop.declarations?.[0];
        const propType = decl ? checker.getTypeOfSymbolAtLocation(prop, decl) : undefined;
        const signature = propType
          ? checker.getNonNullableType(propType).getCallSignatures()[0]
          : undefined;
        const doc = clip(ts.displayPartsToString(prop.getDocumentationComment(checker)), 320);
        if (!signature || !decl)
          return {
            name: prop.name,
            kind: 'value',
            params: [],
            returns: propType ? show(propType) : '',
            ...(doc ? { doc } : {}),
          };
        const params = signature.getParameters().map((p): Param => {
          const pDecl = p.valueDeclaration as ts.ParameterDeclaration | undefined;
          const pType = checker.getTypeOfSymbolAtLocation(p, decl);
          const optional = !!pDecl && (!!pDecl.questionToken || !!pDecl.initializer);
          return {
            name: p.name,
            type: show(pType),
            ...(optional ? { optional: true as const } : {}),
          };
        });
        const paramTypes = signature
          .getParameters()
          .map((p) => [p, checker.getTypeOfSymbolAtLocation(p, decl)] as const);
        const txParam = paramTypes.find(([, t]) => typeName(t) === 'Transaction');
        const tx = txParam
          ? (txParam[0].valueDeclaration as ts.ParameterDeclaration | undefined)?.questionToken
            ? 'optional'
            : 'required'
          : undefined;
        return {
          name: prop.name,
          kind: 'method',
          params,
          returns: show(signature.getReturnType()),
          // A hook keeps what it is given and calls it later, so it hands back a way to let go.
          ...(paramTypes.some(([p, t]) => !['tx', 'caller'].includes(p.name) && callable(t)) &&
          /=>\s*(?:void|Promise<void>)|dispose\(\)/.test(show(signature.getReturnType()))
            ? { hook: true as const }
            : {}),
          ...(tx ? { tx } : {}),
          ...(paramTypes.some(([, t]) => typeName(t) === 'Caller')
            ? { caller: true as const }
            : {}),
          ...(doc ? { doc } : {}),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  for (const source of sources) {
    const visit = (node: ts.Node) => {
      if (
        ts.isModuleDeclaration(node) &&
        ts.isStringLiteral(node.name) &&
        node.name.text === 'cordis' &&
        node.body &&
        ts.isModuleBlock(node.body)
      )
        for (const statement of node.body.statements)
          if (ts.isInterfaceDeclaration(statement) && statement.name.text === 'Context')
            for (const member of statement.members) {
              if (!ts.isPropertySignature(member) || !member.type) continue;
              const key = member.name.getText(source);
              const type = checker.getTypeFromTypeNode(member.type);
              const symbol = symbolOf(type);
              const provider = providerOf.get(key);
              if (!symbol || !provider || services.has(key)) continue;
              services.set(key, {
                key,
                provider,
                type: symbol.name,
                symbol,
                members: membersOf(type),
              });
            }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const serviceBySymbol = new Map([...services.values()].map((s) => [s.symbol, s]));
  const memberNames = new Set([...services.values()].flatMap((s) => s.members.map((m) => m.name)));

  /* ---------- per-file scan: calls, tools, events, SQL ---------- */
  const calls = new Map<string, Record<string, Record<string, Sites>>>(); // from -> service -> method
  const tools = new Map<
    string,
    { name: string; readOnly: boolean; description: string; file: string }
  >();
  const toolCalls: { from: string; tool: string; site: string }[] = [];
  const emits: { pkg: string; type: string; file: string }[] = [];
  const consumes: { pkg: string; type: string; file: string }[] = [];
  const sqlTexts: { pkg: string; file: string; text: string }[] = [];
  const literal = (node?: ts.Node) =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : undefined;
  const site = (source: ts.SourceFile, node: ts.Node) =>
    `${rel(source.fileName)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const servicesOfType = (
    type: ts.Type,
  ): (typeof services extends Map<string, infer V> ? V : never)[] => {
    const t = checker.getNonNullableType(type);
    const parts = t.isUnionOrIntersection() ? t.types : [t];
    return parts.flatMap((part) => {
      const s = serviceBySymbol.get(symbolOf(part)!);
      return s ? [s] : [];
    });
  };
  for (const source of sources) {
    const pkg = pkgOf(source.fileName);
    const file = rel(source.fileName);
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && memberNames.has(node.name.text)) {
        for (const service of servicesOfType(checker.getTypeAtLocation(node.expression))) {
          if (service.provider === pkg || !service.members.some((m) => m.name === node.name.text))
            continue;
          const byService = calls.get(pkg) ?? {};
          const byMethod = (byService[service.key] ??= {});
          const entry = (byMethod[node.name.text] ??= { count: 0, sites: [] });
          entry.count++;
          if (entry.sites.length < 4) entry.sites.push(site(source, node));
          calls.set(pkg, byService);
        }
      }
      if (ts.isObjectLiteralExpression(node)) {
        const prop = (name: string) => {
          const p = node.properties.find(
            (p) => p.name && ts.isIdentifier(p.name) && p.name.text === name,
          );
          return p && ts.isPropertyAssignment(p) ? p.initializer : undefined;
        };
        const name = literal(prop('name'));
        const description = literal(prop('description'));
        if (name && TOOL.test(name) && description !== undefined)
          tools.set(name, {
            name,
            description: clip(description, 400),
            readOnly: prop('readOnly')?.kind === ts.SyntaxKind.TrueKeyword,
            file,
          });
        const type = literal(prop('type'));
        if (type && EVENT.test(type) && prop('types') === undefined)
          emits.push({ pkg, type, file });
        const types = prop('types');
        if (types && ts.isArrayLiteralExpression(types) && (prop('handle') || prop('id')))
          for (const element of types.elements) {
            const value = literal(element);
            if (value && EVENT.test(value)) consumes.push({ pkg, type: value, file });
          }
      }
      if (ts.isCallExpression(node)) {
        const callee = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : ts.isIdentifier(node.expression)
            ? node.expression.text
            : '';
        if (callee === 'register') {
          const name = literal(node.arguments[0]);
          const description = literal(node.arguments[1]);
          if (name && TOOL.test(name) && description !== undefined)
            tools.set(name, {
              name,
              description: clip(description, 400),
              readOnly: node.arguments[4]?.kind === ts.SyntaxKind.TrueKeyword,
              file,
            });
        }
        if (callee === 'call' && ts.isPropertyAccessExpression(node.expression)) {
          const name = literal(node.arguments[0]);
          if (name && TOOL.test(name))
            toolCalls.push({ from: pkg, tool: name, site: site(source, node) });
        }
        if (EMITTERS.test(callee))
          for (const arg of node.arguments) {
            const value = literal(arg);
            if (value && EVENT.test(value)) emits.push({ pkg, type: value, file });
          }
      }
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node)
      )
        sqlTexts.push({ pkg, file, text: node.getText(source) });
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const toolNames = new Set(tools.keys());
  const eventsOut = emits.filter((e) => !toolNames.has(e.type));
  const eventsIn = consumes.filter((e) => !toolNames.has(e.type));
  const knownEvents = new Set([...eventsOut, ...eventsIn].map((e) => e.type));

  /* ---------- tables ---------- */
  const tableOwner = new Map<string, { pkg: string; file: string }>();
  for (const { pkg, file, text } of sqlTexts)
    for (const match of text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi)) {
      const name = match[1].toLowerCase();
      const current = tableOwner.get(name);
      if (!current || (current.pkg === 'contracts' && pkg !== 'contracts'))
        tableOwner.set(name, { pkg, file });
    }
  const migrationFile = new Map<string, boolean>();
  const isMigration = (file: string) => {
    if (!migrationFile.has(file))
      migrationFile.set(
        file,
        /\.migrate\(|migrations?\b|postgres\.ts$|schema\.ts$/.test(file) ||
          readFileSync(resolve(root, file), 'utf8').includes('.migrate('),
      );
    return migrationFile.get(file)!;
  };
  const tableAccess = new Map<
    string,
    Record<string, { runtime: number; migration: number; sites: Set<string> }>
  >();
  for (const { pkg, file, text } of sqlTexts)
    for (const match of text.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+([a-z_][a-z0-9_]*)/gi)) {
      const name = match[1].toLowerCase();
      const owner = tableOwner.get(name);
      if (!owner || owner.pkg === pkg) continue;
      const key = `${pkg}>${owner.pkg}`;
      const byTable = tableAccess.get(key) ?? {};
      const entry = (byTable[name] ??= { runtime: 0, migration: 0, sites: new Set() });
      if (isMigration(file)) entry.migration++;
      else entry.runtime++;
      entry.sites.add(file);
      tableAccess.set(key, byTable);
    }

  /* ---------- files and internal imports ---------- */
  const fileInfo = (pkg: string) => {
    const files = [...serverFiles, ...webFiles].filter((file) => pkgOf(file) === pkg);
    const index = new Map(files.map((file, i) => [file, i]));
    return files.map((file) => {
      const text = readFileSync(file, 'utf8');
      const imports = new Set<number>();
      for (const match of text.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
        const target = resolve(dirname(file), match[1]).replace(/\.js$/, '');
        for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
          const hit = index.get(target + ext);
          if (hit !== undefined) {
            imports.add(hit);
            break;
          }
        }
      }
      return {
        path: relative(resolve(root, 'packages', pkg), file),
        loc: text.split('\n').length,
        imports: [...imports].sort((a, b) => a - b),
      };
    });
  };

  /* ---------- plugins ---------- */
  const realms = JSON.parse(
    readFileSync(resolve(root, 'docs/architecture/atlas/realms.json'), 'utf8'),
  ) as {
    research: string[];
    library: string[];
    labels: Record<string, string>;
    purposes?: Record<string, string>;
  };
  // Purposes and region names come from the hand-written explorer notes, keyed by service.
  const notes = JSON.parse(
    readFileSync(resolve(root, 'docs/architecture/explorer/notes.json'), 'utf8'),
  ) as {
    plugins: Record<string, { label: string; purpose: string }>;
    hierarchy: {
      layers: { label: string; members: string[] }[];
      boundaries: { label: string; members: string[] }[];
    };
  };
  const pkgOfKey = (key: string) =>
    providerOf.get(key) ?? (packages.includes(key) ? key : undefined);
  const inventoryByPkg = new Map<string, InventoryPlugin[]>();
  for (const plugin of inventory.plugins) {
    const pkg = plugin.source.split('/')[1];
    if (plugin.source.startsWith('packages/'))
      inventoryByPkg.set(pkg, [...(inventoryByPkg.get(pkg) ?? []), plugin]);
  }
  const plugins = packages.map((pkg) => {
    const files = fileInfo(pkg);
    const own = inventoryByPkg.get(pkg) ?? [];
    const machine = own.some((p) => p.runtime === 'machine');
    return {
      id: pkg,
      label:
        realms.labels[pkg] ??
        pkg.replace(/(^|-)([a-z])/g, (_, s: string, c: string) => (s ? ' ' : '') + c.toUpperCase()),
      realm: realms.research.includes(pkg)
        ? 'research'
        : realms.library.includes(pkg)
          ? 'library'
          : machine
            ? 'machine'
            : 'foundation',
      purpose:
        [...(inventoryByPkg.get(pkg)?.flatMap((p) => p.provides) ?? []), pkg]
          .map((key) => notes.plugins[key]?.purpose)
          .find(Boolean) ??
        realms.purposes?.[pkg] ??
        '',
      loc: files.reduce((n, f) => n + f.loc, 0),
      adapters: own
        .filter((p) => p.kind !== 'service')
        .map((p) => p.kind)
        .sort(),
      files,
      services: [...services.values()]
        .filter((s) => s.provider === pkg)
        .map((s) => ({ key: s.key, type: s.type, members: s.members }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      tools: [...tools.values()]
        .filter((t) => pkgOf(resolve(root, t.file)) === pkg)
        .map((t) => ({ ...t, file: relative(`packages/${pkg}`, t.file) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      tables: [...tableOwner]
        .filter(([, o]) => o.pkg === pkg)
        .map(([name, o]) => ({ name, file: relative(`packages/${pkg}`, o.file) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      emits: [...new Set(eventsOut.filter((e) => e.pkg === pkg).map((e) => e.type))].sort(),
      consumes: [...new Set(eventsIn.filter((e) => e.pkg === pkg).map((e) => e.type))].sort(),
    };
  });

  /* ---------- edges ---------- */
  const declared = new Map<string, 'required' | 'optional'>();
  for (const plugin of inventory.plugins) {
    if (!plugin.source.startsWith('packages/')) continue;
    const from = plugin.source.split('/')[1];
    for (const [deps, level] of [
      [plugin.requires, 'required'],
      [plugin.optional, 'optional'],
    ] as const)
      for (const key of deps) {
        const to = providerOf.get(key);
        if (!to || to === from) continue;
        const k = `${from}>${to}`;
        if (level === 'required' || !declared.has(k)) declared.set(k, level);
      }
  }
  const callEdges = new Map<
    string,
    {
      from: string;
      to: string;
      declared: 'required' | 'optional' | null;
      services: Record<string, Record<string, Sites>>;
    }
  >();
  for (const [k, level] of declared) {
    const [from, to] = k.split('>');
    callEdges.set(k, { from, to, declared: level, services: {} });
  }
  for (const [from, byService] of calls)
    for (const [key, methods] of Object.entries(byService)) {
      const to = services.get(key)!.provider;
      const k = `${from}>${to}`;
      const edge = callEdges.get(k) ?? { from, to, declared: null, services: {} };
      edge.services[key] = sortKeys(methods);
      callEdges.set(k, edge);
    }
  const toolOwner = (name: string) => {
    const t = tools.get(name);
    return t ? pkgOf(resolve(root, t.file)) : undefined;
  };
  const toolEdges = new Map<string, { from: string; to: string; tools: Record<string, Sites> }>();
  for (const call of toolCalls) {
    const to = toolOwner(call.tool);
    if (!to || to === call.from) continue;
    const k = `${call.from}>${to}`;
    const edge = toolEdges.get(k) ?? { from: call.from, to, tools: {} };
    const entry = (edge.tools[call.tool] ??= { count: 0, sites: [] });
    entry.count++;
    if (entry.sites.length < 4) entry.sites.push(call.site);
    toolEdges.set(k, edge);
  }
  const eventEdges = new Map<string, { from: string; to: string; types: string[] }>();
  for (const out of eventsOut)
    for (const inn of eventsIn) {
      if (out.type !== inn.type || out.pkg === inn.pkg) continue;
      const k = `${out.pkg}>${inn.pkg}`;
      const edge = eventEdges.get(k) ?? { from: out.pkg, to: inn.pkg, types: [] };
      if (!edge.types.includes(out.type)) edge.types.push(out.type);
      eventEdges.set(k, edge);
    }
  const edges = [
    ...[...callEdges.values()].map((e) => ({
      kind: 'call' as const,
      ...e,
      services: sortKeys(e.services),
    })),
    ...[...eventEdges.values()].map((e) => ({
      kind: 'event' as const,
      ...e,
      types: e.types.sort(),
    })),
    ...[...tableAccess].map(([k, byTable]) => {
      const [from, to] = k.split('>');
      return {
        kind: 'table' as const,
        from,
        to,
        tables: sortKeys(
          Object.fromEntries(
            Object.entries(byTable).map(([name, v]) => [
              name,
              { runtime: v.runtime, migration: v.migration, files: [...v.sites].sort() },
            ]),
          ),
        ),
      };
    }),
    ...[...toolEdges.values()].map((e) => ({
      kind: 'tool' as const,
      ...e,
      tools: sortKeys(e.tools),
    })),
    ...inventory.connections
      .map((c) => ({
        kind: 'http' as const,
        from: c.from,
        to: c.to === 'api' ? 'sessions' : c.to,
        protocol: c.protocol,
      }))
      .filter((c) => packages.includes(c.from) && packages.includes(c.to)),
  ].sort((a, b) => `${a.kind}${a.from}${a.to}`.localeCompare(`${b.kind}${b.from}${b.to}`));

  return {
    snapshot: inventory.snapshot,
    plugins,
    edges,
    stateMachines: await stateMachines(root, serverFiles),
    regions: [...notes.hierarchy.layers, ...notes.hierarchy.boundaries]
      .map((region) => ({
        label: region.label,
        members: [...new Set(region.members.map(pkgOfKey).filter((m): m is string => !!m))].sort(),
      }))
      .filter((region) => region.members.length),
    unmatchedEvents: [...knownEvents].filter(
      (type) => !eventsOut.some((e) => e.type === type) || !eventsIn.some((e) => e.type === type),
    ).length,
  };
}

export async function writeAtlas(root: string, inventory: Inventory): Promise<void> {
  const directory = resolve(root, 'docs/architecture/atlas');
  const atlas = await compileAtlas(root, inventory);
  writeFileSync(resolve(directory, 'atlas.json'), JSON.stringify(atlas, null, 1) + '\n');
  const shell = readFileSync(resolve(directory, 'shell.html'), 'utf8');
  const html = shell
    .replace('/* ATLAS_CSS */', () => readFileSync(resolve(directory, 'atlas.css'), 'utf8'))
    .replace('/* ATLAS_DATA */', () => JSON.stringify(atlas).replaceAll('<', '\\u003c'))
    .replace('/* ATLAS_JS */', () => readFileSync(resolve(directory, 'atlas.js'), 'utf8'));
  writeFileSync(resolve(directory, 'index.html'), html);
}
