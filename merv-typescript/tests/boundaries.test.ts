import { sandboxesHostCapabilities } from '../packages/sandboxes/src/host-capabilities.js';
import { artifactsPlugin } from '@merv/artifacts';
import { blobsPlugin } from '@merv/blobs';
import { codePlugin } from '@merv/code';
import { codePlugin as codeWorkPlugin } from '@merv/code-work';
import { contextBuilderPlugin } from '@merv/context-builder';
import { domainEventsPlugin } from '@merv/domain-events';
import { feedPlugin } from '@merv/feed';
import { fleetPlugin } from '@merv/fleet';
import { legacyHistoryPlugin } from '@merv/legacy-history';
import { identityPlugin } from '@merv/identity';
import { piPlugin } from '@merv/pi';
import { paperPlugin } from '@merv/paper';
import { reportsPlugin } from '@merv/reports';
import { reviewsPlugin } from '@merv/reviews';
import { codeWorkspaceDriver } from '@merv/code/driver/index';
import { runnerWith } from '@merv/runner';
import { scopePlugin } from '@merv/scope';
import { sessionsPlugin } from '@merv/sessions';
import { statePlugin } from '@merv/state';
import { secretsPlugin } from '@merv/secrets';
import { nisaPlugin } from '@merv/nisa';
import { tasksPlugin } from '@merv/tasks';
import { toolsPlugin } from '@merv/api';
import { webPlugin } from '@merv/web';
import { workflowsPlugin } from '@merv/workflows';
import type { SbxMerv } from '@sandboxes/merv-host';
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
import { stateConfig } from './fixtures/state.js';

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
  experiments: [
    'state',
    'scope',
    'artifacts',
    'workflows',
    'reviews',
    'contextBuilder',
    'codeWork',
    'paper',
    'sessions',
  ],
  knowledge: [
    'state',
    'scope',
    'tasks',
    'experiments',
    'artifacts',
    'reviews',
    'workflows',
    'codeWork',
  ],
  research: [
    'state',
    'scope',
    'workflows',
    'domainEvents',
    'paper',
    'reflections',
    'tasks',
    'experiments',
    'artifacts',
    'codeWork',
  ],
  paper: ['state', 'scope', 'artifacts'],
  // One persistent report draft per subject, rendered to PDF; subjects register their owners.
  reports: ['state', 'scope', 'artifacts'],
  reflections: [
    'state',
    'scope',
    'artifacts',
    'workflows',
    'reviews',
    'contextBuilder',
    'paper',
    'sessions',
  ],
  workflows: ['state', 'scope'],
  reviews: ['state', 'scope', 'artifacts', 'domainEvents'],
  tasks: [
    'state',
    'scope',
    'workflows',
    'artifacts',
    'reviews',
    'contextBuilder',
    'codeWork',
    'paper',
  ],
  feed: ['state', 'scope', 'artifacts'],
  // Whiteboards: shapes and their versions; a card names a record by id and reads nothing of it.
  board: ['state', 'scope'],
  // The read-only archive of research imported from the previous server.
  legacyHistory: ['state', 'scope'],
  identity: [],
  // Account ciphertext storage is separate from identity authentication and scope authority.
  secrets: ['state'],
  sessions: ['state', 'scope', 'workflows', 'domainEvents', 'blobs'],
  // Code follows session attach and close events to open and end writer generations.
  code: ['state', 'scope', 'domainEvents'],
  codeWork: ['code', 'state', 'scope', 'sessions', 'workflows', 'reviews', 'domainEvents'],
  runner: [],
  pi: ['state', 'scope', 'fleet', 'tools', 'blobs'],
  sandboxEvidence: [
    'state',
    'scope',
    'workflows',
    'domainEvents',
    'sessions',
    'artifacts',
    'sbxMerv',
    'sbxPipelines',
    'sbxObjects',
    'sbxAccounts',
    'sbxJobs',
    'sbxRegistry',
  ],
  // Each verified person's own Sandboxes account, which Sandboxes keeps with its credits.
  sandboxesPeople: [
    'scope',
    'sbxAuth',
    'sbxAccounts',
    'sbxBilling',
    'sbxProviders',
    'sbxDb',
    'sbxClock',
  ],
  // Stripe for every plugin that sells: its webhook's events, dispatched to their sellers.
  payments: ['api'],
  // Internet search through outside providers; its budgets live in memory.
  web: [],
  // Agents' scripts, each in a sandboxed child; its tools adapter makes their calls.
  scripts: [],
  // Literature retrieval and account-backed research require fresh caller scope checks.
  nisa: ['scope'],
  // Machines on demand through Sandboxes; the workflow adapter adds Sessions only when installed.
  fleet: ['state', 'scope', 'sbxMerv'],
  tools: ['scope'],
  api: ['scope', 'tools', 'identity'],
  mounts: ['tools', 'scope'],
  ui: ['api', 'tools'],
};
const hostCapabilities = new Set<string>(sandboxesHostCapabilities);
const knownCapability = (name: string) => name in capabilities || hostCapabilities.has(name);
const optionalCapabilities: Record<string, readonly string[]> = {
  // Pi may investigate Sessions' questions, but either service boots without the other.
  pi: ['sessions'],
  // Optional: a deployment may run no sandboxes at all, and a project may have no
  // connection. Research integration owns project checks; Code is an independent utility.
  codeWork: ['sbxMerv', 'sbxObjects', 'sbxPipelines', 'sbxRegistry', 'sbxJobs', 'sbxSnapshots'],
  experiments: ['sandboxEvidence', 'reports'],
  // A used-up limit rules out the verdicts that would return the work; every owner that says
  // which verdicts do runs on Workflows, so Reviews outlives its unload.
  reviews: ['workflows'],
  // Sessions admits session callers in whichever tool registry is loaded; with none there
  // is no tool call to admit, and the registry refuses session callers until it registers.
  // Transcripts go to Blobs while it is loaded; without it a runner is told to retry.
  sessions: ['tools', 'secrets'],
  tasks: ['sandboxEvidence'],
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
        ts.isStringLiteral(element) && knownCapability(element.text),
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
    if (knownCapability(accessed))
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
// The in-process host's console composes API and UI; its proxy is transport-only.
const consoleAdapters = new Set([
  join('customer-experiments', 'src', 'index.ts'),
  join('sandboxes', 'src', 'console.ts'),
  join('sandboxes', 'src', 'sandboxes-proxy.ts'),
]);
const sorted = (values: readonly string[]) => [...values].sort();
const ownerOf = (path: string) => relative(packagesRoot, path).split(sep)[0];
const capabilityOf = (owner: string) =>
  owner.replace(/-(\w)/g, (_, letter) => letter.toUpperCase());

/**
 * Contracts belongs to no component. Besides its index, a component may run only these shared
 * modules: the portable id and Git schemas a browser-safe protocol module is built from, and the
 * text helpers, which a pure rules module the browser also runs may import in the index's place.
 */
const contractsRuntimeExports = new Set([
  'async',
  'origins',
  'private-directory',
  'schemas',
  'text',
  'workspace',
]);
const sharedContract = (specifier: string) =>
  specifier === '@merv/contracts' ||
  (specifier.startsWith('@merv/contracts/') &&
    contractsRuntimeExports.has(specifier.slice('@merv/contracts/'.length)));

/** A unit's pure rules, which other units may run: the compute capability, experiment naming and
 * limits, review independence, returns and history, the prerequisite guard, the paper's Problem, an
 * artifact as a context item, the retirement ledger text every retirement migration embeds, what
 * a runner advertises, the agent stream and its harness readers, a Pi conversation's live view, the remote-row manifest, hosted Codex's profile and handoff
 * grace, the lease rows every leased step keeps, a record's Code unit, a unit's history as its
 * owner tells it on the Work page, and its Artifacts tab. */
const pureRules = new Set([
  '@merv/sessions/compute',
  '@merv/workflows/rules',
  '@merv/workflows/retired-instances',
  '@merv/experiments/rules',
  '@merv/reviews/rules',
  '@merv/reviews/unit-history',
  '@merv/reviews/returns',
  '@merv/artifacts/unit-files',
  '@merv/reviews/running',
  '@merv/scope/rules',
  '@merv/reflections/names',
  '@merv/workflows/execution',
  '@merv/fleet/model-ledger',
  '@merv/fleet/model-requests',
  '@merv/fleet/hosted-codex',
  '@merv/workflows/dependency-rows',
  '@merv/workflows/lease-rows',
  '@merv/code-work/workspace',
  '@merv/code-work/record-unit',
  '@merv/paper/rules',
  '@merv/reports/prefill',
  '@merv/context-builder/artifact-item',
  '@merv/sessions/rules',
  '@merv/sessions/compute',
  '@merv/sessions/agent-stream',
  '@merv/ui/manifest',
  '@merv/pi/live',
]);

/** This adapter composes the Git utility; no other feature may import its implementation. */
const codeUtilityExports = new Set([
  'base-merge',
  'git',
  'github',
  'github-client',
  'input',
  'pending-merge',
  'service',
  'store/mirror',
  'store/operations',
  'store/protocol',
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
  const isAdapter = adapterKind(path) !== undefined || consoleAdapters.has(relative(base, path));
  for (const reference of moduleReferences(source)) {
    const { specifier, typeOnly } = reference;
    // Contracts is no component: any of its modules may be named for types alone, which is how
    // a portable /models module reaches the code and store shapes it is built from.
    const contractTypes = typeOnly && specifier.startsWith('@merv/contracts/');
    if (specifier.startsWith('@merv/') && !sharedContract(specifier) && !contractTypes) {
      const utility =
        owner === 'code-work' &&
        specifier.startsWith('@merv/code/') &&
        codeUtilityExports.has(specifier.slice('@merv/code/'.length));
      // Identity's credential store is a public shared authority, also usable by standalone services.
      const credentials =
        ['scope', 'sessions', 'pi', 'admin'].includes(owner) &&
        specifier === '@merv/identity/credentials';
      // API's server-sent-events writer and its unknown-endpoint error, for the HTTP adapters.
      // Customer experiments serves its request's intake conversation to the customer the same way.
      const events =
        (isAdapter && ['@merv/api/event-stream', '@merv/api/errors'].includes(specifier)) ||
        (owner === 'customer-experiments' && specifier === '@merv/api/event-stream');
      // The integration publishes its capture reader contract alongside its implementation.
      const captureTypes = typeOnly && specifier === '@merv/sandboxes/sandbox-evidence';
      // Pure rules (no service, see the test below) that any unit may run.
      const requestStorage = owner === 'customer-experiments' && specifier === '@merv/blobs/s3';
      if (
        !utility &&
        !credentials &&
        !events &&
        !captureTypes &&
        !requestStorage &&
        !pureRules.has(specifier)
      ) {
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
          !/(?:^|[/\\])(tools|ui|api|http|registry)\.[cm]?[jt]s$/.test(specifier) &&
            !consoleAdapters.has(relative(base, target).replace(/\.js$/, '.ts')),
          `${path} loads a transport adapter from its core entrypoint`,
        );
    }
    // An operator-side client module (`*-client.ts`, loaded by the CLI, never by a plugin) may
    // speak to the server through the MCP client.
    const mcpClient =
      /-client\.ts$/.test(path) && specifier.startsWith('@modelcontextprotocol/sdk/client/');
    if (!['api', 'mounts'].includes(owner) && !mcpClient) {
      assert.ok(
        !specifier.startsWith('@modelcontextprotocol/') &&
          (!['node:http', 'node:https', 'express', 'fastify'].includes(specifier) ||
            // Only this console transport forwards HTTP and WebSocket requests upstream.
            (specifier === 'node:http' &&
              relative(base, path) === join('sandboxes', 'src', 'sandboxes-proxy.ts')) ||
            // API adapters and Fleet's model relay name the request types their handlers take.
            (specifier === 'node:http' &&
              typeOnly &&
              (adapterKind(path) === 'api' ||
                (owner === 'fleet' && path.split(sep).at(-1) === 'model-relay.ts')))),
        `${path} embeds an API transport`,
      );
    }
  }
}

test('implementation imports remain inside their component and away from transport adapters', () => {
  for (const path of sourceFiles) assertComponentReferences(path, parse(path));
  // The console transport allowance must not let the Sandboxes core embed or load transport.
  const core = join(packagesRoot, 'sandboxes', 'src', 'integration.ts');
  for (const specifier of ['./console.js', './sandboxes-proxy.js', 'node:http'])
    assert.throws(
      () =>
        assertComponentReferences(
          core,
          ts.createSourceFile(core, `import '${specifier}';`, ts.ScriptTarget.Latest, true),
        ),
      /transport/,
    );
});

/** Research logic. Every other package is a foundation, which must not know it. */
const research = new Set(['tasks', 'experiments', 'knowledge', 'reflections', 'research', 'paper']);
test('foundations import no research package, not even for types, and list none', () => {
  for (const path of sourceFiles.filter((path) => !research.has(ownerOf(path))))
    for (const { specifier } of moduleReferences(parse(path)))
      assert.ok(
        !/^@merv\//.test(specifier) || !research.has(specifier.split('/')[1]!),
        `${relative(root, path)}: a foundation imports research logic: ${specifier}`,
      );
  for (const name of packageNames.filter((name) => !research.has(name))) {
    const manifest = JSON.parse(readFileSync(join(packagesRoot, name, 'package.json'), 'utf8'));
    const listed = Object.keys(manifest.dependencies ?? {}).filter((dependency) =>
      research.has(dependency.replace(/^@merv\//, '')),
    );
    assert.deepEqual(listed, [], `${name}: a foundation depends on research logic`);
  }
});

test('pure rule modules that other units run import nothing but contracts and zod', () => {
  for (const specifier of pureRules) {
    const [, name, file] = specifier.split('/');
    for (const reference of moduleReferences(parse(join(packagesRoot, name!, 'src', `${file}.ts`))))
      assert.ok(
        ['@merv/contracts', '@merv/contracts/text', 'zod'].includes(reference.specifier) ||
          (reference.typeOnly && reference.specifier.startsWith('@merv/contracts/')) ||
          // Its own unit's public types, or another unit's, which hold no runtime.
          (reference.typeOnly &&
            (reference.specifier === './models.js' ||
              /^@merv\/[a-z-]+\/models$/.test(reference.specifier))) ||
          // Another pure rule module of its own unit.
          pureRules.has(`@merv/${name}/${reference.specifier.replace(/^\.\/|\.js$/g, '')}`),
        `${specifier} imports ${reference.specifier}`,
      );
  }
});

test('a machine’s private directory has one definition, in the workspace driver contract', () => {
  // The runner and Code's workspace driver both keep storage in private directories and may
  // not import each other, so the one definition lives with the contract between them.
  const definitions = sourceFiles.filter((path) =>
    /\b(?:function|const|let)\s+privateDirectory\b/.test(readFileSync(path, 'utf8')),
  );
  assert.deepEqual(
    definitions.map((path) => relative(root, path)),
    [join('packages', 'contracts', 'src', 'private-directory.ts')],
  );
});

test('Pi SDK imports stay in the sandbox worker, outside every server entrypoint', () => {
  const piRoot = join(packagesRoot, 'pi', 'src');
  const worker = join(piRoot, 'worker.ts');
  const sdk = (specifier: string) => specifier.startsWith('@earendil-works/pi-');
  assert.ok(moduleReferences(parse(worker)).some(({ specifier }) => sdk(specifier)));
  for (const path of sourceFiles) {
    for (const { specifier } of moduleReferences(parse(path))) {
      if (sdk(specifier)) assert.equal(path, worker, `${path}: Pi SDK is worker-only`);
      assert.ok(
        path === worker || specifier !== '@merv/pi/worker',
        `${path}: the server must not load the Pi worker`,
      );
    }
  }
  const visited = new Set<string>();
  const inspect = (path: string) => {
    if (visited.has(path)) return;
    visited.add(path);
    assert.notEqual(path, worker, 'A Pi server entrypoint imports the SDK worker');
    for (const { specifier, typeOnly } of moduleReferences(parse(path))) {
      if (typeOnly || !specifier.startsWith('.')) continue;
      const dependency = relativeTypeTarget(path, specifier);
      if (dependency.startsWith(`${piRoot}${sep}`)) inspect(dependency);
    }
  };
  for (const entry of ['index', 'tools', 'ui', 'api']) inspect(join(piRoot, `${entry}.ts`));
});

/** Git accepts opaque unit identities and checkout DTOs, never research services or decisions. */
function assertCodeUtility(source: ts.SourceFile): void {
  for (const { specifier } of moduleReferences(source))
    assert.ok(
      !/^@merv\/(?:sessions|workflows|reviews|sandboxes|code-work)(?:\/|$)/.test(specifier),
      `${source.fileName}: Code must not depend on a research service: ${specifier}`,
    );
  visit(source, (node) => {
    if (ts.isIdentifier(node))
      assert.ok(
        !/^(?:Workflows?|Reviews?|Sessions|Sandboxes)(?:$|[A-Z])/.test(node.text) ||
          (node.text === 'WorkflowWorkspacePolicy' &&
            /[/\\]driver[/\\](?:index|local|checkout)\.ts$/.test(source.fileName)),
        `${source.fileName}: research service or policy type ${node.text} belongs in Code Work`,
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
      // Its callers already proved the project exists: Scope's rows are Scope's to read.
      assert.ok(
        !/\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:projects|actors|actor_credentials|member_actors|project_memberships)\b/i.test(
          node.text,
        ),
        `${source.fileName}: Code must not read Scope's tables`,
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
    "export type { Code } from '@merv/code-work/types';",
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
    assert.throws(() => verify(code), /research|Code Work/);
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
  assert.doesNotThrow(() => verify("ctx.inject(['codeWork'], (ctx) => ctx.codeWork);"));
  assert.throws(
    () => verify("ctx.inject(['codeWork'], (ctx) => ctx.codeWork); ctx.codeWork;"),
    /undeclared dependency/,
  );
  assert.throws(
    () => verify("ctx.inject(['codeWork'], (ctx) => ctx.sessions);"),
    /undeclared dependency/,
  );
  assert.throws(
    () => verify("ctx.inject(['sbxMerv'], (ctx) => ctx.sbxMerv); ctx.sbxMerv;"),
    /undeclared dependency/,
  );
});

test('Cordis service requirements match the architecture and every accessed capability is declared', () => {
  const provided = new Set<string>();
  const orchestrationAdapters = new Set<string>();
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
      if (name.text === 'merv-customer-experiments') {
        assert.equal(relative(packagesRoot, path), join('customer-experiments', 'src', 'index.ts'));
        assert.deepEqual(
          sorted(declared),
          sorted([
            'state',
            'scope',
            'artifacts',
            'workflows',
            'reviews',
            'codeWork',
            'sessions',
            'sandboxEvidence',
            'reports',
            'sbxMerv',
            'sbxAccounts',
            'sbxDb',
            'sbxBilling',
            'sbxProviders',
            'sbxVault',
            'sbxSettings',
            'sbxResourceLimits',
            'pi',
            'tools',
            'api',
          ]),
        );
        // Identity for its v3 customers and Payments for its checkout, where loaded.
        assert.deepEqual(sorted([...optional]), ['identity', 'payments']);
        // Its snapshot and work reads for the platform admin, which takes them where loaded.
        assert.deepEqual(actualProvided, ['customerExperiments']);
        return;
      }
      if (name.text === 'merv-admin') {
        assert.equal(relative(packagesRoot, path), join('admin', 'src', 'index.ts'));
        // Its audit's state; the routes, platform authority and caller rules wait for the API,
        // Scope and the tools registry. It reads every other owner's service where that is
        // loaded (ctx.get).
        assert.deepEqual(sorted(declared), ['state']);
        assert.deepEqual(sorted([...optional]), ['api', 'scope', 'tools']);
        assert.deepEqual(actualProvided, []);
        return;
      }
      if (name.text === 'merv-fleet-workflow') {
        assert.equal(relative(packagesRoot, path), join('fleet', 'src', 'workflow.ts'));
        assert.deepEqual(sorted(declared), ['api', 'fleet', 'scope', 'sessions', 'state', 'tools']);
        assert.deepEqual(sorted([...optional]), []);
        // An adapter, not a service: it registers tools and routes and nothing injects it.
        assert.deepEqual(actualProvided, []);
        assert.ok(!orchestrationAdapters.has(name.text), 'Duplicate workflow orchestration');
        orchestrationAdapters.add(name.text);
        return;
      }
      if (name.text === 'merv-sandboxes-credits') {
        assert.equal(relative(packagesRoot, path), join('sandboxes', 'src', 'credits.ts'));
        // A person's top-ups of their own account, sold through Payments when loaded.
        assert.deepEqual(sorted(declared), [
          'api',
          'sandboxesPeople',
          'sbxProviders',
          'sbxSettings',
        ]);
        assert.deepEqual(sorted([...optional]), ['payments']);
        assert.deepEqual(actualProvided, []);
        assert.ok(!orchestrationAdapters.has(name.text), 'Duplicate compute orchestration');
        orchestrationAdapters.add(name.text);
        return;
      }
      if (name.text === 'merv-sandboxes-console') {
        assert.equal(relative(packagesRoot, path), join('sandboxes', 'src', 'console.ts'));
        assert.deepEqual(sorted(declared), [
          'api',
          'sbxClock',
          'sbxDb',
          'sbxMerv',
          'sbxRegistry',
          'sbxSettings',
          'scope',
          'ui',
        ]);
        assert.deepEqual(sorted([...optional]), []);
        assert.deepEqual(actualProvided, []);
        assert.ok(!orchestrationAdapters.has(name.text), 'Duplicate console orchestration');
        orchestrationAdapters.add(name.text);
        return;
      }
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
  assert.deepEqual(sorted([...orchestrationAdapters]), [
    'merv-fleet-workflow',
    'merv-sandboxes-console',
    'merv-sandboxes-credits',
  ]);
});

test('feature adapters inject their owner and one registry, without acquiring sibling business capabilities', () => {
  const expected: Record<keyof typeof adapterKinds, string[]> = {
    tools: [
      'artifacts',
      'board',
      'code-work',

      'experiments',
      'feed',
      'fleet',
      'knowledge',
      'nisa',
      'paper',
      'pi',
      'reflections',
      'reports',
      'research',
      'reviews',
      'scope',
      'scripts',
      'sessions',
      'tasks',
      'web',
      'workflows',
    ],
    ui: [
      'artifacts',
      'board',
      'code-work',

      'experiments',
      'feed',
      'fleet',
      'legacy-history',
      'mounts',
      'paper',
      'pi',
      'reflections',
      'research',
      'reviews',
      'sessions',
      'tasks',
      'workflows',
    ],
    api: ['code-work', 'pi', 'scope', 'secrets', 'sessions'],
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
      // Project invitations (founder, 2026-10-14) look recipients up in the identity directory
      // from Scope's HTTP adapter: the one recorded exception.
      const allowed = [
        capability,
        registry,
        'scope',
        ...(owner === 'scope' && kind === 'api' ? ['identity'] : []),
      ];
      assert.ok(
        declared.every((name) => allowed.includes(name)),
        `${owner}: cross-feature orchestration belongs in a program service`,
      );
      visit(declaration, (child) => {
        if (
          ts.isPropertyAccessExpression(child) &&
          ts.isIdentifier(child.expression) &&
          child.expression.text === 'ctx' &&
          knownCapability(child.name.text)
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
          `${path}: a public type contract cannot be imported as a runtime value`,
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

test('each service boots with only its declared dependency closure and without API', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-independent-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credentialEnv = 'MERV_BOUNDARY_RUNNER_CREDENTIAL';
  const webKeyEnv = 'MERV_BOUNDARY_WEB_KEY';
  const nisaKeyEnv = 'MERV_BOUNDARY_NISA_KEY';
  const piSecretEnv = 'MERV_BOUNDARY_PI_SECRET';
  const piModelKeyEnv = 'MERV_BOUNDARY_PI_MODEL_KEY';
  const previousCredential = process.env[credentialEnv];
  process.env[credentialEnv] = 'synthetic-boundary-source';
  process.env[webKeyEnv] = 'tvly-synthetic';
  process.env[nisaKeyEnv] = 'rr_sk_synthetic';
  process.env[piSecretEnv] = 'synthetic-boundary-pi-signing-secret';
  process.env[piModelKeyEnv] = 'synthetic-model-key';
  t.after(() => {
    if (previousCredential === undefined) delete process.env[credentialEnv];
    else process.env[credentialEnv] = previousCredential;
    delete process.env[webKeyEnv];
    delete process.env[nisaKeyEnv];
    delete process.env[piSecretEnv];
    delete process.env[piModelKeyEnv];
  });
  const plugins: Record<string, { plugin: any; config?: any }> = {
    domainEvents: { plugin: domainEventsPlugin },
    contextBuilder: { plugin: contextBuilderPlugin },
    state: { plugin: statePlugin, config: stateConfig(':memory:') },
    blobs: { plugin: blobsPlugin, config: { root: directory } },
    scope: { plugin: scopePlugin },
    artifacts: { plugin: artifactsPlugin },
    paper: { plugin: paperPlugin },
    reports: { plugin: reportsPlugin },
    workflows: { plugin: workflowsPlugin },
    reviews: { plugin: reviewsPlugin },
    tasks: { plugin: tasksPlugin },
    feed: { plugin: feedPlugin },
    legacyHistory: { plugin: legacyHistoryPlugin },
    identity: { plugin: identityPlugin },
    secrets: { plugin: secretsPlugin },
    tools: { plugin: toolsPlugin },
    fleet: {
      plugin: fleetPlugin,
      config: {
        profiles: [
          {
            key: 'standard',
            provider: 'boundary',
            offerId: 'offer',
            releaseId: `rt1_${'0'.repeat(64)}`,
            leaseSeconds: 900,
          },
        ],
      },
    },
    // Loading Pi is its switch, so it boots with its host and credentials.
    pi: {
      plugin: piPlugin,
      config: {
        baseUrl: 'http://127.0.0.1:1/',
        secretEnv: piSecretEnv,
        modelApiKeyEnv: piModelKeyEnv,
        host: { projectId: 'synthetic', credentialEnv },
      },
    },
    web: { plugin: webPlugin, config: { keyEnv: webKeyEnv, origin: 'http://127.0.0.1:1' } },
    nisa: { plugin: nisaPlugin, config: { keyEnv: nisaKeyEnv, origin: 'http://127.0.0.1:1' } },
    sessions: { plugin: sessionsPlugin },
    code: { plugin: codePlugin, config: { repositories: { root: join(directory, 'code') } } },
    codeWork: { plugin: codeWorkPlugin },
    runner: {
      plugin: runnerWith([codeWorkspaceDriver]),
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
  // External host capabilities are leaves of Merv's closure. The host's real boot is
  // covered in sandboxes-host.test.ts; this fixture has no linked projects or runtimes.
  const hostPlugins: Record<string, { plugin: any; config?: any }> = {
    sbxMerv: {
      plugin: (ctx: Context) => {
        ctx.provide('sbxMerv', { linked: async () => null } as unknown as SbxMerv);
      },
    },
  };
  for (const target of Object.keys(plugins))
    await t.test(target, async () => {
      const required = new Set<string>();
      const include = (name: string) => {
        if (required.has(name)) return;
        required.add(name);
        if (hostCapabilities.has(name)) return;
        for (const dependency of capabilities[name]) include(dependency);
      };
      include(target);
      const ctx = new Context();
      try {
        // Install the requested service first: activation must follow dependency availability.
        const fibers = [];
        for (const name of required) {
          const provider = plugins[name] ?? hostPlugins[name];
          assert.ok(provider, `Missing dependency fixture for ${name}`);
          fibers.push(await ctx.plugin(provider.plugin, provider.config));
        }
        await Promise.all(fibers.map((fiber) => fiber.await()));
        const deadline = Date.now() + 5000;
        while ([...required].some((name) => !ctx.get(name)) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        for (const name of [...Object.keys(capabilities), ...hostCapabilities])
          assert.equal(
            !!ctx.get(name),
            required.has(name),
            `${target}: unexpected ${name} availability`,
          );
        assert.equal(!!ctx.get('api'), false, `${target}: core service booted API`);
        if (target === 'sessions') {
          assert.equal(!!ctx.get('fleet'), false, 'Sessions does not require Fleet');
          assert.equal(!!ctx.get('pi'), false, 'Sessions does not require Pi');
        }
        if (target === 'fleet') assert.equal(!!ctx.get('pi'), false, 'Fleet does not require Pi');
        if (target === 'pi') {
          assert.equal(!!ctx.get('sessions'), false, 'Pi does not require Sessions');
          assert.ok(ctx.get('fleet'), 'Pi hard-depends on Fleet');
          assert.ok(ctx.get('tools'), 'Pi requires the native ToolRegistry');
        }
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
          const credentials = await ctx.scope.credentials.bootstrap({
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
            if (target === 'tasks') {
              assert.deepEqual(await ctx.tasks.list(caller), []);
              // Code Work is in Tasks' closure, so a new task gets its managed Git unit.
              const task = await ctx.tasks.create(caller, {
                title: 'Standalone task',
                goal: 'Run alone.',
                checks: ['The service works.'],
                briefId: artifact.id,
                requestId: 'task',
              });
              assert.deepEqual(
                (await ctx.tasks.list(caller)).map(({ id }: { id: string }) => id),
                [task.id],
              );
            }
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

test('every package dependency installs at the root, the only node_modules the image ships', () => {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, unknown>;
  };
  assert.deepEqual(
    Object.keys(lock.packages).filter((path) => /^packages\/[^/]+\/node_modules\//.test(path)),
    [],
  );
});
