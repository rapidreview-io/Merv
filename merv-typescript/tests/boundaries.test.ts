import { artifactsPlugin } from '@merv/artifacts';
import { blobsPlugin } from '@merv/blobs';
import { codePlugin } from '@merv/code';
import { contextBuilderPlugin } from '@merv/context-builder';
import { domainEventsPlugin } from '@merv/domain-events';
import { feedPlugin } from '@merv/feed';
import { identityPlugin } from '@merv/identity';
import { reviewsPlugin } from '@merv/reviews';
import { runnerPlugin } from '@merv/runner';
import { scopePlugin } from '@merv/scope';
import { sessionsPlugin } from '@merv/sessions';
import { statePlugin } from '@merv/state';
import { tasksPlugin } from '@merv/tasks';
import { workflowsPlugin } from '@merv/workflows';
import { Context } from 'cordis';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesRoot = join(root, 'packages');
const packageNames = readdirSync(packagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const walkFiles = (path: string): string[] =>
  readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walkFiles(join(path, entry.name)) : [join(path, entry.name)],
  );
const sourceFiles = packageNames
  .flatMap((name) => walkFiles(join(packagesRoot, name, 'src')))
  .filter((path) => path.endsWith('.ts'));
const parse = (path: string) =>
  ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
function visit(node: ts.Node, fn: (node: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}
const property = (node: ts.ObjectLiteralExpression, name: string) =>
  node.properties.find(
    (prop) =>
      prop.name &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
      prop.name.text === name,
  );
const initializer = (node: ts.ObjectLiteralElementLike | undefined) =>
  node && ts.isPropertyAssignment(node) ? node.initializer : undefined;

/** Architectural policy, independent of package manifests and runtime declarations. */
const capabilities: Record<string, readonly string[]> = {
  state: [],
  domainEvents: ['state'],
  contextBuilder: ['state', 'scope', 'artifacts'],
  blobs: [],
  scope: ['state'],
  artifacts: ['state', 'scope', 'blobs'],
  experiments: ['state', 'scope', 'artifacts', 'workflows', 'reviews', 'contextBuilder', 'paper'],
  knowledge: ['state', 'scope', 'tasks', 'experiments', 'artifacts', 'reviews', 'workflows'],
  research: ['state', 'scope', 'workflows'],
  paper: ['state', 'scope', 'artifacts'],
  reflections: ['state', 'scope', 'artifacts', 'workflows', 'reviews', 'contextBuilder', 'paper'],
  workflows: ['state', 'scope'],
  reviews: ['state', 'scope', 'artifacts', 'domainEvents'],
  tasks: ['state', 'scope', 'workflows', 'artifacts', 'reviews', 'contextBuilder'],
  feed: ['state', 'scope', 'artifacts'],
  identity: [],
  sessions: ['state', 'scope', 'workflows', 'domainEvents'],
  code: ['state', 'scope'],
  codeResearch: ['code', 'state', 'scope', 'sessions', 'artifacts', 'workflows', 'domainEvents'],
  runner: [],
  // A proxy for rows a service outside this process publishes: no Merv capability at all.
  sandboxes: [],
  tools: ['scope'],
  api: ['scope', 'tools', 'identity'],
  mounts: ['tools', 'scope'],
  ui: ['api', 'tools'],
};
const optionalCapabilities: Record<string, readonly string[]> = {
  // Optional: a deployment may run no sandboxes at all, and a project may have no
  // connection. Research integration owns project checks; Code is an independent utility.
  codeResearch: ['reviews', 'sandboxes'],
  experiments: ['codeResearch'],
  research: [
    'domainEvents',
    'paper',
    'reflections',
    'knowledge',

    'tasks',
    'experiments',
    'artifacts',
    'codeResearch',
  ],
  knowledge: ['codeResearch'],
  tasks: ['codeResearch'],
};

/** Child injections may use their dependencies only inside their own callback. */
function checkCapabilityAccess(node: ts.Node, declared: readonly string[], optional: Set<string>) {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'ctx' &&
    node.expression.name.text === 'inject'
  ) {
    const [deps, callback] = node.arguments;
    assert.ok(deps && ts.isArrayLiteralExpression(deps), 'Child injection must be a static list');
    assert.ok(
      callback && ts.isArrowFunction(callback),
      'Child injection must have an inline callback',
    );
    const childDeps = deps.elements.map((element) => {
      assert.ok(
        ts.isStringLiteral(element) && element.text in capabilities,
        'Unknown child capability',
      );
      optional.add(element.text);
      return element.text;
    });
    checkCapabilityAccess(callback, [...declared, ...childDeps], optional);
    return;
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'ctx'
  ) {
    const accessed = node.name.text;
    if (accessed in capabilities)
      assert.ok(declared.includes(accessed), `ctx.${accessed} is an undeclared dependency`);
    assert.notEqual(accessed, 'root', 'Root-context access bypasses declared dependencies');
  }
  ts.forEachChild(node, (child) => checkCapabilityAccess(child, declared, optional));
}
/** Feature adapters publish to a transport or UI registry without owning domain state. */
const adapterKinds = { tools: 'tools', ui: 'ui', api: 'api' } as const;
const adapterKind = (path: string) =>
  (/[/\\](tools|ui|api)\.ts$/.exec(path)?.[1] as keyof typeof adapterKinds | undefined) ??
  undefined;
const sorted = (values: readonly string[]) => [...values].sort();
const ownerOf = (path: string) => relative(packagesRoot, path).split(sep)[0];
const capabilityOf = (owner: string) => (owner === 'code-research' ? 'codeResearch' : owner);

/** This adapter composes the Git utility; no other feature may import its implementation. */
const codeUtilityExports = new Set([
  'base-merge',
  'base-plan',
  'base-schema',
  'changes',
  'git',
  'github',
  'github-client',
  'input',
  'operation-journal',
  'pending-merge',
  'postgres-guard',
  'publications-schema',
  'service',
  'store/backup',
  'store/mirror',
  'store/operations',
  'store/refs',
  'store/repository',
  'units',
  'writers',
]);

interface ModuleReference {
  specifier: string;
  typeOnly: boolean;
}
function moduleReferences(source: ts.SourceFile): ModuleReference[] {
  const result: ModuleReference[] = [];
  visit(source, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      assert.ok(
        ts.isStringLiteral(node.moduleSpecifier),
        `${source.fileName}: module path must be static`,
      );
      const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
      const bindings = clause?.namedBindings;
      const typeOnly = ts.isImportDeclaration(node)
        ? !!clause &&
          (clause.isTypeOnly ||
            (!clause.name &&
              !!bindings &&
              ts.isNamedImports(bindings) &&
              bindings.elements.length > 0 &&
              bindings.elements.every((element) => element.isTypeOnly)))
        : node.isTypeOnly ||
          (!!node.exportClause &&
            ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.length > 0 &&
            node.exportClause.elements.every((element) => element.isTypeOnly));
      result.push({ specifier: node.moduleSpecifier.text, typeOnly });
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      assert.ok(
        node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression),
        `${source.fileName}: import-equals must have a static path`,
      );
      result.push({ specifier: node.moduleReference.expression.text, typeOnly: node.isTypeOnly });
    }
    if (ts.isImportTypeNode(node)) {
      assert.ok(
        ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal),
        `${source.fileName}: imported types must have a static path`,
      );
      result.push({ specifier: node.argument.literal.text, typeOnly: true });
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      assert.equal(
        node.arguments.length,
        1,
        `${source.fileName}: dynamic imports must have one static path`,
      );
      assert.ok(
        ts.isStringLiteral(node.arguments[0]),
        `${source.fileName}: computed imports defeat component boundaries`,
      );
      result.push({ specifier: node.arguments[0].text, typeOnly: false });
    }
  });
  return result;
}

function publicTypesTarget(specifier: string, base: string): string {
  const match = /^@merv\/([^/]+)\/(types|models)$/.exec(specifier);
  assert.ok(
    match,
    `${specifier}: cross-component imports must use a public /types or /models contract`,
  );
  const directory = join(base, match[1]);
  const manifestPath = join(directory, 'package.json');
  assert.ok(existsSync(manifestPath), `${specifier}: package manifest is missing`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    name: string;
    exports: Record<string, unknown>;
  };
  assert.equal(manifest.name, `@merv/${match[1]}`, `${specifier}: package identity mismatch`);
  const wildcard = manifest.exports['./*'];
  const target =
    manifest.exports[`./${match[2]}`] ??
    (typeof wildcard === 'string' ? wildcard.replace('*', match[2]) : undefined);
  assert.ok(
    typeof target === 'string' && target.startsWith('./') && !target.includes('..'),
    `${specifier}: missing or escaping /types export`,
  );
  const path = resolve(directory, target);
  assert.ok(existsSync(path), `${specifier}: /types export has no file`);
  const actual = realpathSync(path);
  assert.ok(
    actual.startsWith(`${realpathSync(directory)}${sep}`),
    `${specifier}: /types export escapes its package`,
  );
  return actual;
}

function relativeTypeTarget(path: string, specifier: string): string {
  const target = resolve(dirname(path), specifier);
  const candidates = [
    target,
    target
      .replace(/\.js$/, '.ts')
      .replace(/\.mjs$/, '.mts')
      .replace(/\.cjs$/, '.cts'),
    `${target}.ts`,
    join(target, 'index.ts'),
  ];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  assert.ok(resolved, `${path}: type dependency does not resolve: ${specifier}`);
  return realpathSync(resolved);
}

function assertTypeOnlyModule(path: string, base: string, seen: Set<string>): void {
  if (seen.has(path)) return;
  seen.add(path);
  const source = parse(path);
  const statementsAreTypes = (statements: readonly ts.Statement[]) => {
    for (const statement of statements) {
      if (
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEmptyStatement(statement)
      )
        continue;
      if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) {
        assert.ok(
          !ts.isImportEqualsDeclaration(statement) || statement.isTypeOnly,
          `${path}: a public type module cannot import runtime aliases`,
        );
        assert.ok(
          moduleReferences(
            ts.createSourceFile(path, statement.getText(source), ts.ScriptTarget.Latest, true),
          ).every((reference) => reference.typeOnly),
          `${path}: a public type module cannot import runtime values`,
        );
        continue;
      }
      if (ts.isExportDeclaration(statement)) {
        const typeOnly =
          statement.isTypeOnly ||
          (!!statement.exportClause &&
            ts.isNamedExports(statement.exportClause) &&
            statement.exportClause.elements.length > 0 &&
            statement.exportClause.elements.every((element) => element.isTypeOnly));
        assert.ok(typeOnly, `${path}: a public type module cannot export runtime values`);
        continue;
      }
      if (ts.isModuleDeclaration(statement)) {
        assert.ok(
          (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Ambient) !== 0 &&
            (ts.isStringLiteral(statement.name) ||
              (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0) &&
            statement.body &&
            ts.isModuleBlock(statement.body),
          `${path}: only ambient interface augmentation is allowed`,
        );
        statementsAreTypes(statement.body.statements);
        continue;
      }
      assert.fail(
        `${path}: a public type module contains a runtime declaration (${ts.SyntaxKind[statement.kind]})`,
      );
    }
  };
  statementsAreTypes(source.statements);
  assertComponentReferences(path, source, base, seen);
  for (const reference of moduleReferences(source)) {
    if (reference.specifier.startsWith('.')) {
      const target = relativeTypeTarget(path, reference.specifier);
      assert.equal(
        relative(base, target).split(sep)[0],
        relative(base, path).split(sep)[0],
        `${path}: a type dependency escapes its component`,
      );
      assertTypeOnlyModule(target, base, seen);
    }
  }
}

function assertComponentReferences(
  path: string,
  source: ts.SourceFile,
  base = packagesRoot,
  seen = new Set<string>(),
): void {
  const owner = relative(base, path).split(sep)[0];
  const isAdapter = adapterKind(path) !== undefined;
  for (const reference of moduleReferences(source)) {
    const { specifier, typeOnly } = reference;
    if (specifier.startsWith('@merv/') && specifier !== '@merv/contracts') {
      const utility =
        owner === 'code-research' &&
        specifier.startsWith('@merv/code/') &&
        codeUtilityExports.has(specifier.slice('@merv/code/'.length));
      if (!utility) {
        assert.ok(
          typeOnly,
          `${path}: importing another component requires an explicit type-only import: ${specifier}`,
        );
        assertTypeOnlyModule(publicTypesTarget(specifier, base), base, seen);
      }
    }
    if (specifier.startsWith('.')) {
      const target = resolve(dirname(path), specifier);
      assert.equal(
        relative(base, target).split(sep)[0],
        owner,
        `${path} crosses a component using a relative path`,
      );
      if (!isAdapter && !['api', 'mounts'].includes(owner))
        assert.ok(
          !/(?:^|[/\\])(tools|ui|api|http|registry)\.[cm]?[jt]s$/.test(specifier),
          `${path} loads a transport adapter from its core entrypoint`,
        );
    }
    if (!['api', 'mounts'].includes(owner)) {
      assert.ok(
        !specifier.startsWith('@modelcontextprotocol/') &&
          !['node:http', 'node:https', 'express', 'fastify'].includes(specifier),
        `${path} embeds an API transport`,
      );
    }
  }
}

test('implementation imports remain inside their component and away from transport adapters', () => {
  for (const path of sourceFiles) assertComponentReferences(path, parse(path));
});

/** Git accepts opaque unit identities and checkout DTOs, never research services or decisions. */
function assertCodeUtility(source: ts.SourceFile): void {
  for (const { specifier } of moduleReferences(source))
    assert.ok(
      !/^@merv\/(?:sessions|workflows|reviews|sandboxes|code-research)(?:\/|$)/.test(specifier),
      `${source.fileName}: Code must not depend on a research service: ${specifier}`,
    );
  visit(source, (node) => {
    if (ts.isIdentifier(node))
      assert.ok(
        !/^(?:Workflows?|Reviews?|Sessions|Sandboxes)(?:$|[A-Z])/.test(node.text) ||
          (node.text === 'WorkflowWorkspacePolicy' &&
            /[/\\]driver[/\\]index\.ts$/.test(source.fileName)),
        `${source.fileName}: research service or policy type ${node.text} belongs in Code Research`,
      );
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      assert.ok(
        !/\b(?:FROM|JOIN|UPDATE|INTO|TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+(?:wf_\w+|reviews|review_\w+|tasks|task_\w+|experiments|experiment_\w+|research_\w+|reflections|reflection_\w+|consolidations|sessions|session_\w+)\b/i.test(
          node.text,
        ),
        `${source.fileName}: Code must not inspect research-owned tables`,
      );
      assert.ok(
        !new Set([
          'workflow.transition',
          'in_progress',
          'in_review',
          'in_design_review',
          'in_results_review',
          'awaiting_publication',
          'consolidating',
          'reflecting',
          'researching',
          'defining',
        ]).has(node.text),
        `${source.fileName}: Code must not interpret research workflow states or events`,
      );
    }
  });
}

test('Code stays independent of research services, their storage and their lifecycle decisions', () => {
  for (const path of sourceFiles.filter((path) => ownerOf(path) === 'code'))
    assertCodeUtility(parse(path));
  const manifest = JSON.parse(readFileSync(join(packagesRoot, 'code', 'package.json'), 'utf8'));
  assert.deepEqual(
    Object.keys(manifest.dependencies).filter((name) => name.startsWith('@merv/')),
    ['@merv/contracts'],
    'The Git utility depends only on shared Merv contracts',
  );
});

test('the Code boundary rejects service aliases, private SQL and lifecycle coupling while allowing transport DTOs', () => {
  const verify = (code: string, path = '/code/src/example.ts') =>
    assertCodeUtility(ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true));
  assert.doesNotThrow(() => verify("import type { SessionWorkspace } from '@merv/contracts';"));
  assert.doesNotThrow(() =>
    verify(
      "import type { WorkflowWorkspacePolicy } from '@merv/contracts';",
      '/code/src/driver/index.ts',
    ),
  );
  assert.doesNotThrow(() => verify("const endpoint = '/pulls/42/reviews';"));
  for (const code of [
    "import type { Sessions } from '@merv/sessions/types';",
    "export type { Code } from '@merv/code-research/types';",
    "const owner = import('@merv/workflows');",
    "import type { Workflows as Work } from '@merv/contracts';",
    "type Policy = import('@merv/contracts').ReviewRequest;",
    "type Policy = import('@merv/contracts').WorkflowWorkspacePolicy;",
    "await tx.get('SELECT * FROM reviews WHERE id=?');",
    'await tx.get(`SELECT id FROM wf_instances WHERE project_id=${project}`);',
    "await tx.run('UPDATE experiment_attempts SET ended_revision=?');",
    "if (state === 'awaiting_publication') publish();",
    "subscribe({ type: 'workflow.transition' });",
  ])
    assert.throws(() => verify(code), /research|Code Research/);
});

test('public contract imports resolve genuine type-only modules without runtime or implementation bypasses', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-contract-boundaries-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const base = join(directory, 'packages');
  const supplier = join(base, 'supplier');
  const consumerPath = join(base, 'consumer', 'src', 'index.ts');
  mkdirSync(join(supplier, 'src'), { recursive: true });
  mkdirSync(dirname(consumerPath), { recursive: true });
  const manifest = {
    name: '@merv/supplier',
    exports: { '.': './src/index.ts', './*': './src/*.ts' },
  };
  const manifestPath = join(supplier, 'package.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(supplier, 'src', 'index.ts'), 'export class Implementation {}');
  const typesPath = join(supplier, 'src', 'types.ts');
  const valid =
    "import type { Caller } from '@merv/contracts'; export interface Contract { caller: Caller }; declare module 'cordis' { interface Context { example: Contract } }";
  writeFileSync(typesPath, valid);
  const verify = (code: string) =>
    assertComponentReferences(
      consumerPath,
      ts.createSourceFile(consumerPath, code, ts.ScriptTarget.Latest, true),
      base,
    );
  for (const code of [
    "import type { Contract } from '@merv/supplier/types';",
    "import { type Contract } from '@merv/supplier/types';",
    "export type { Contract } from '@merv/supplier/types';",
    "type Local = import('@merv/supplier/types').Contract;",
  ])
    assert.doesNotThrow(() => verify(code));
  for (const code of [
    "import { Contract } from '@merv/supplier/types';",
    "import { type Contract, Implementation } from '@merv/supplier/types';",
    "import '@merv/supplier/types';",
    "export { Contract } from '@merv/supplier/types';",
    "const implementation = import('@merv/supplier/types');",
    "const implementation = require('@merv/supplier/types');",
    "import implementation = require('@merv/supplier/types');",
    "import type { Implementation } from '@merv/supplier';",
    "import type { Contract } from '../../supplier/src/types.js';",
  ])
    assert.throws(() => verify(code), /type-only|public \/types|relative path/);
  for (const disguised of [
    'export const implementation = 1;',
    'export declare const implementation: number;',
    'export class Implementation {}',
    'export function implementation() {}',
    'export enum Implementation { Value }',
    "import './index.js'; export interface Contract {}",
    'import Implementation = Global.Factory; export interface Contract {}',
    "export type { Implementation } from './index.js';",
    "export type { Implementation } from '@merv/supplier';",
    "declare module 'cordis' { export const implementation: number }",
  ]) {
    writeFileSync(typesPath, disguised);
    assert.throws(
      () => verify("import type { Contract } from '@merv/supplier/types';"),
      /runtime|public \/types/,
    );
  }
  writeFileSync(typesPath, valid);
  writeFileSync(
    manifestPath,
    JSON.stringify({ ...manifest, exports: { ...manifest.exports, './types': './src/index.ts' } }),
  );
  assert.throws(
    () => verify("import type { Contract } from '@merv/supplier/types';"),
    /runtime declaration/,
  );
  writeFileSync(
    manifestPath,
    JSON.stringify({
      ...manifest,
      exports: { ...manifest.exports, './types': '../consumer/src/index.ts' },
    }),
  );
  assert.throws(() => verify("import type { Contract } from '@merv/supplier/types';"), /escaping/);
});

test('optional capabilities cannot escape their Cordis child injection', () => {
  const verify = (code: string) =>
    checkCapabilityAccess(
      ts.createSourceFile('optional.ts', code, ts.ScriptTarget.Latest, true),
      [],
      new Set(),
    );
  assert.doesNotThrow(() => verify("ctx.inject(['codeResearch'], (ctx) => ctx.codeResearch);"));
  assert.throws(
    () => verify("ctx.inject(['codeResearch'], (ctx) => ctx.codeResearch); ctx.codeResearch;"),
    /undeclared dependency/,
  );
  assert.throws(
    () => verify("ctx.inject(['codeResearch'], (ctx) => ctx.sessions);"),
    /undeclared dependency/,
  );
});

test('Cordis service requirements match the architecture and every accessed capability is declared', () => {
  const provided = new Set<string>();
  for (const path of sourceFiles.filter((path) => adapterKind(path) === undefined)) {
    visit(parse(path), (node) => {
      if (!ts.isObjectLiteralExpression(node) || !property(node, 'apply')) return;
      const name = initializer(property(node, 'name'));
      if (!name || !ts.isStringLiteral(name) || !name.text.startsWith('merv-')) return;
      const deps = initializer(property(node, 'inject'));
      assert.ok(
        !deps || ts.isArrayLiteralExpression(deps),
        `${name.text}: injection must be statically declared`,
      );
      const declared =
        deps && ts.isArrayLiteralExpression(deps)
          ? deps.elements.map((element) => {
              assert.ok(
                ts.isStringLiteral(element),
                `${name.text}: injection names must be static`,
              );
              return element.text;
            })
          : [];
      const actualProvided: string[] = [];
      const optional = new Set<string>();
      checkCapabilityAccess(node, declared, optional);
      visit(node, (child) => {
        if (
          ts.isCallExpression(child) &&
          ts.isPropertyAccessExpression(child.expression) &&
          child.expression.name.text === 'provide'
        ) {
          assert.ok(
            ts.isStringLiteral(child.arguments[0]),
            `${name.text}: provided service name must be static`,
          );
          actualProvided.push(child.arguments[0].text);
        }
      });
      assert.equal(
        actualProvided.length,
        1,
        `${name.text} must provide one independently owned service`,
      );
      const service = actualProvided[0];
      assert.deepEqual(
        sorted([...optional]),
        sorted(optionalCapabilities[service] ?? []),
        `${name.text}: optional dependency policy changed`,
      );
      assert.ok(service in capabilities, `Add the architectural policy for new service ${service}`);
      assert.deepEqual(
        sorted(declared),
        sorted(capabilities[service]),
        `${name.text}: service dependency policy changed`,
      );
      assert.ok(!provided.has(service), `Multiple components claim the ${service} capability`);
      provided.add(service);
    });
  }
  assert.deepEqual(
    sorted([...provided]),
    sorted(Object.keys(capabilities)),
    'Every architectural service must have an actual plugin provider',
  );
});

test('feature adapters inject their owner and one registry, without acquiring sibling business capabilities', () => {
  const expected: Record<keyof typeof adapterKinds, string[]> = {
    tools: [
      'artifacts',
      'code-research',

      'experiments',
      'feed',
      'knowledge',
      'paper',
      'reflections',
      'research',
      'reviews',
      'sandboxes',
      'scope',
      'sessions',
      'tasks',
      'workflows',
    ],
    ui: [
      'artifacts',
      'code-research',

      'experiments',
      'feed',
      'knowledge',
      'mounts',
      'paper',
      'reflections',
      'research',
      'reviews',
      'sandboxes',
      'scope',
      'sessions',
      'tasks',
    ],
    api: ['code-research', 'sessions'],
  };
  for (const kind of Object.keys(adapterKinds) as (keyof typeof adapterKinds)[]) {
    const registry = adapterKinds[kind];
    const adapters = sourceFiles.filter((path) => adapterKind(path) === kind);
    assert.deepEqual(sorted(adapters.map(ownerOf)), expected[kind]);
    for (const path of adapters) {
      const owner = ownerOf(path);
      const capability = capabilityOf(owner);
      const declarations: ts.ObjectLiteralExpression[] = [];
      visit(parse(path), (node) => {
        if (
          ts.isObjectLiteralExpression(node) &&
          property(node, 'apply') &&
          property(node, 'inject')
        )
          declarations.push(node);
      });
      assert.equal(declarations.length, 1, `${owner}: expected one ${kind} adapter plugin`);
      const declaration = declarations[0];
      const deps = initializer(property(declaration, 'inject'));
      assert.ok(deps && ts.isArrayLiteralExpression(deps));
      const declared = deps.elements.map((value) => {
        assert.ok(ts.isStringLiteral(value));
        return value.text;
      });
      assert.ok(
        declared.includes(capability),
        `${owner}: ${kind} adapter must inject its own feature`,
      );
      assert.ok(declared.includes(registry), `${owner}: ${kind} adapter must inject ${registry}`);
      assert.ok(
        declared.every((name) => [capability, registry, 'scope'].includes(name)),
        `${owner}: cross-feature orchestration belongs in a program service`,
      );
      visit(declaration, (child) => {
        if (
          ts.isPropertyAccessExpression(child) &&
          ts.isIdentifier(child.expression) &&
          child.expression.text === 'ctx' &&
          child.name.text in capabilities
        ) {
          assert.ok(
            declared.includes(child.name.text),
            `${owner}: undeclared ${kind}-adapter dependency ${child.name.text}`,
          );
        }
      });
    }
  }
});

test('workspace exports and imported export subpaths resolve to real implementation files', () => {
  const manifests = new Map(
    packageNames.map((name) => [
      name,
      JSON.parse(readFileSync(join(packagesRoot, name, 'package.json'), 'utf8')) as {
        name: string;
        exports: Record<string, string>;
      },
    ]),
  );
  for (const [name, manifest] of manifests) {
    assert.equal(manifest.name, `@merv/${name}`);
    assert.ok(manifest.exports['.'], `${name}: missing root export`);
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      assert.equal(
        typeof target,
        'string',
        `${name}/${subpath}: unsupported export mapping; extend verification when introducing conditions`,
      );
      assert.ok(
        target.startsWith('./') && !target.includes('..'),
        `${name}: export escapes package root`,
      );
      if (target.includes('*')) {
        const [prefix, suffix] = target.slice(2).split('*');
        const matches = walkFiles(join(packagesRoot, name))
          .map((file) => relative(join(packagesRoot, name), file))
          .filter((file) => file.startsWith(prefix) && file.endsWith(suffix));
        assert.ok(matches.length > 0, `${name}/${subpath}: wildcard export has no implementation`);
      } else
        assert.ok(
          existsSync(join(packagesRoot, name, target)),
          `${name}/${subpath}: exported file does not exist`,
        );
    }
  }
  const consumers = [
    ...sourceFiles,
    ...walkFiles(join(root, 'src')),
    ...walkFiles(join(root, 'tests')),
  ].filter((path) => path.endsWith('.ts'));
  for (const path of consumers)
    for (const reference of moduleReferences(parse(path))) {
      const { specifier } = reference;
      if (!specifier.startsWith('@merv/')) continue;
      const [, name, ...segments] = specifier.split('/');
      const manifest = manifests.get(name);
      assert.ok(manifest, `${relative(root, path)} references absent package ${name}`);
      const subpath = segments.length ? `./${segments.join('/')}` : '.';
      if (subpath === './types') {
        assert.ok(
          reference.typeOnly,
          `${path}: a public /types contract cannot be imported as a runtime value`,
        );
        assertTypeOnlyModule(publicTypesTarget(specifier, packagesRoot), packagesRoot, new Set());
      }
      const target =
        manifest.exports[subpath] ??
        (manifest.exports['./*'] && manifest.exports['./*'].replace('*', segments.join('/')));
      assert.ok(
        target && existsSync(join(packagesRoot, name, target)),
        `${relative(root, path)}: ${specifier} does not resolve to an exported file`,
      );
    }
});

test('each service boots with only its declared dependency closure and without API or tools', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-independent-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credentialEnv = 'MERV_BOUNDARY_RUNNER_CREDENTIAL';
  const previousCredential = process.env[credentialEnv];
  process.env[credentialEnv] = 'synthetic-boundary-source';
  t.after(() => {
    if (previousCredential === undefined) delete process.env[credentialEnv];
    else process.env[credentialEnv] = previousCredential;
  });
  const plugins: Record<string, { plugin: any; config?: any }> = {
    domainEvents: { plugin: domainEventsPlugin },
    contextBuilder: { plugin: contextBuilderPlugin },
    state: { plugin: statePlugin, config: { path: ':memory:' } },
    blobs: { plugin: blobsPlugin, config: { root: directory } },
    scope: { plugin: scopePlugin },
    artifacts: { plugin: artifactsPlugin },
    workflows: { plugin: workflowsPlugin },
    reviews: { plugin: reviewsPlugin },
    tasks: { plugin: tasksPlugin },
    feed: { plugin: feedPlugin },
    identity: { plugin: identityPlugin },
    sessions: { plugin: sessionsPlugin },
    code: { plugin: codePlugin },
    runner: {
      plugin: runnerPlugin,
      config: {
        directory: join(directory, 'machine'),
        baseUrl: 'http://127.0.0.1:1',
        projectId: 'synthetic',
        credentialEnv,
        profiles: [],
        requestTimeoutMs: 100,
      },
    },
  };
  for (const target of Object.keys(plugins))
    await t.test(target, async () => {
      const required = new Set<string>();
      const include = (name: string) => {
        if (required.has(name)) return;
        required.add(name);
        for (const dependency of capabilities[name]) include(dependency);
      };
      include(target);
      const ctx = new Context();
      try {
        // Install the requested service first: activation must follow dependency availability.
        const fibers = [];
        for (const name of required)
          fibers.push(await ctx.plugin(plugins[name].plugin, plugins[name].config));
        await Promise.all(fibers.map((fiber) => fiber.await()));
        const deadline = Date.now() + 5000;
        while ([...required].some((name) => !ctx.get(name)) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        for (const name of Object.keys(capabilities))
          assert.equal(
            !!ctx.get(name),
            required.has(name),
            `${target}: unexpected ${name} availability`,
          );
        if (target === 'state')
          assert.equal(
            (
              await ctx.state.read(
                async (sql) => await sql.get<{ answer: number }>('SELECT 42 AS answer'),
              )
            )?.answer,
            42,
          );
        if (target === 'blobs') {
          const stored = await ctx.blobs.put('isolated', Buffer.from('durable bytes'));
          assert.equal((await ctx.blobs.get('isolated', stored.hash)).toString(), 'durable bytes');
        }
        if (required.has('scope')) {
          const credentials = await ctx.scope.bootstrap({
            projectName: 'Independent component',
            actorName: 'Operator',
          });
          const caller = { actorId: credentials.actor.id, projectId: credentials.project.id };
          assert.equal((await ctx.scope.project(caller)).id, caller.projectId);
          if (target === 'workflows') {
            const program = await ctx.workflows.register({
              name: 'minimal',
              version: 1,
              initial: 'done',
              states: ['done'],
              terminal: ['done'],
              edges: [],
            });
            assert.equal(
              (await program.start(caller, { workflow: 'minimal', requestId: 'start' })).state,
              'done',
            );
          }
          if (required.has('artifacts')) {
            const artifact = await ctx.artifacts.create(caller, {
              title: 'Brief',
              content: 'Goal: Run alone.\nCheck: The service works.',
            });
            assert.equal(
              (await ctx.artifacts.read(caller, artifact.id)).content,
              'Goal: Run alone.\nCheck: The service works.',
            );
            if (target === 'reviews')
              assert.equal(
                (
                  await ctx.reviews.request(caller, {
                    subjectId: 'opaque-target',
                    subjectRevision: 0,
                    producerId: caller.actorId,
                    artifactIds: [artifact.id],
                    criteria: ['The service works.'],
                    requestId: 'review',
                  })
                ).status,
                'requested',
              );
            if (target === 'tasks')
              assert.equal(
                (
                  await ctx.tasks.create(caller, {
                    title: 'Standalone task',
                    goal: 'Run alone.',
                    checks: ['The service works.'],
                    briefId: artifact.id,
                    requestId: 'task',
                  })
                ).workflow.state,
                'in_progress',
              );
            if (target === 'feed')
              assert.equal(
                (
                  await ctx.feed.post(caller, {
                    body: 'The service works.',
                    artifactIds: [artifact.id],
                    requestId: 'post',
                  })
                ).body,
                'The service works.',
              );
          }
        }
      } finally {
        await ctx.fiber.dispose();
      }
    });
});
