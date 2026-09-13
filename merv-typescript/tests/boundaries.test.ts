import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { Context } from 'cordis'
import { statePlugin } from '@merv/state'
import { blobsPlugin } from '@merv/blobs'
import { scopePlugin } from '@merv/scope'
import { artifactsPlugin } from '@merv/artifacts'
import { workflowsPlugin } from '@merv/workflows'
import { reviewsPlugin } from '@merv/reviews'
import { tasksPlugin } from '@merv/tasks'
import { feedPlugin } from '@merv/feed'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesRoot = join(root, 'packages')
const packageNames = readdirSync(packagesRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
const walkFiles = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walkFiles(join(path, entry.name)) : [join(path, entry.name)])
const sourceFiles = packageNames.flatMap(name => walkFiles(join(packagesRoot, name, 'src'))).filter(path => path.endsWith('.ts'))
const parse = (path: string) => ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
function visit(node: ts.Node, fn: (node: ts.Node) => void): void { fn(node); ts.forEachChild(node, child => visit(child, fn)) }
const property = (node: ts.ObjectLiteralExpression, name: string) => node.properties.find(prop => prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) && prop.name.text === name)
const initializer = (node: ts.ObjectLiteralElementLike | undefined) => node && ts.isPropertyAssignment(node) ? node.initializer : undefined

/** Architectural policy, independent of package manifests and runtime declarations. */
const capabilities: Record<string, readonly string[]> = {
  state: [], blobs: [], scope: ['state'], artifacts: ['state', 'scope', 'blobs'],
  workflows: ['state', 'scope'], reviews: ['state', 'scope', 'artifacts'],
  tasks: ['state', 'scope', 'workflows', 'artifacts', 'reviews'],
  feed: ['state', 'scope', 'artifacts'],
  tools: ['scope'], api: ['scope', 'tools'],
}
const sorted = (values: readonly string[]) => [...values].sort()
const ownerOf = (path: string) => relative(packagesRoot, path).split(sep)[0]

function references(source: ts.SourceFile): string[] {
  const result: string[] = []
  visit(source, node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      assert.ok(ts.isStringLiteral(node.moduleSpecifier), `${source.fileName}: module path must be static`)
      result.push(node.moduleSpecifier.text)
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) result.push(node.argument.literal.text)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      assert.equal(node.arguments.length, 1, `${source.fileName}: dynamic imports must have one static path`)
      assert.ok(ts.isStringLiteral(node.arguments[0]), `${source.fileName}: computed imports defeat component boundaries`)
      result.push(node.arguments[0].text)
    }
  })
  return result
}

test('implementation imports remain inside their component and away from transport adapters', () => {
  for (const path of sourceFiles) {
    const owner = ownerOf(path)
    const isAdapter = path.endsWith(`${sep}tools.ts`)
    for (const specifier of references(parse(path))) {
      if (specifier.startsWith('@merv/')) {
        assert.equal(specifier, '@merv/contracts', `${relative(root, path)} imports another component implementation: ${specifier}; inject its contract`)
      }
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(path), specifier)
        assert.equal(ownerOf(target), owner, `${relative(root, path)} crosses a component using a relative path`)
        if (!isAdapter && owner !== 'api') assert.ok(!/(?:^|[/\\])(tools|http|registry)\.[cm]?[jt]s$/.test(specifier), `${relative(root, path)} loads a transport adapter from its core entrypoint`)
      }
      if (owner !== 'api') {
        assert.ok(!specifier.startsWith('@modelcontextprotocol/') && !['node:http', 'node:https', 'express', 'fastify'].includes(specifier), `${relative(root, path)} embeds an API transport`)
      }
    }
  }
})

test('Cordis service requirements match the architecture and every accessed capability is declared', () => {
  const provided = new Set<string>()
  for (const path of sourceFiles.filter(path => !path.endsWith(`${sep}tools.ts`))) {
    visit(parse(path), node => {
      if (!ts.isObjectLiteralExpression(node) || !property(node, 'apply')) return
      const name = initializer(property(node, 'name'))
      if (!name || !ts.isStringLiteral(name) || !name.text.startsWith('merv-')) return
      const deps = initializer(property(node, 'inject'))
      assert.ok(!deps || ts.isArrayLiteralExpression(deps), `${name.text}: injection must be statically declared`)
      const declared = deps && ts.isArrayLiteralExpression(deps) ? deps.elements.map(element => {
        assert.ok(ts.isStringLiteral(element), `${name.text}: injection names must be static`)
        return element.text
      }) : []
      const actualProvided: string[] = []
      visit(node, child => {
        if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) && child.expression.name.text === 'provide') {
          assert.ok(ts.isStringLiteral(child.arguments[0]), `${name.text}: provided service name must be static`)
          actualProvided.push(child.arguments[0].text)
        }
        if (ts.isPropertyAccessExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'ctx') {
          const accessed = child.name.text
          if (accessed in capabilities) assert.ok(declared.includes(accessed), `${name.text}: ctx.${accessed} is an undeclared dependency`)
          assert.notEqual(accessed, 'root', `${name.text}: root-context access bypasses declared dependencies`)
        }
      })
      assert.equal(actualProvided.length, 1, `${name.text} must provide one independently owned service`)
      const service = actualProvided[0]
      assert.ok(service in capabilities, `Add the architectural policy for new service ${service}`)
      assert.deepEqual(sorted(declared), sorted(capabilities[service]), `${name.text}: service dependency policy changed`)
      assert.ok(!provided.has(service), `Multiple components claim the ${service} capability`)
      provided.add(service)
    })
  }
  assert.deepEqual(sorted([...provided]), sorted(Object.keys(capabilities)), 'Every architectural service must have an actual plugin provider')
})

test('feature tools inject their owner and registry, without acquiring sibling business capabilities', () => {
  const adapters = sourceFiles.filter(path => path.endsWith(`${sep}tools.ts`))
  assert.deepEqual(sorted(adapters.map(ownerOf)), ['artifacts', 'feed', 'reviews', 'scope', 'tasks', 'workflows'])
  for (const path of adapters) {
    const owner = ownerOf(path)
    const declarations: ts.ObjectLiteralExpression[] = []
    visit(parse(path), node => {
      if (ts.isObjectLiteralExpression(node) && property(node, 'apply') && property(node, 'inject')) declarations.push(node)
    })
    assert.equal(declarations.length, 1, `${owner}: expected one feature adapter plugin`)
    const declaration = declarations[0]
    const deps = initializer(property(declaration, 'inject'))
    assert.ok(deps && ts.isArrayLiteralExpression(deps))
    const declared = deps.elements.map(value => { assert.ok(ts.isStringLiteral(value)); return value.text })
    assert.ok(declared.includes(owner), `${owner}: tool adapter must inject its own feature`)
    assert.ok(declared.includes('tools'), `${owner}: tool adapter must inject the registry`)
    assert.ok(declared.every(name => [owner, 'tools', 'scope'].includes(name)), `${owner}: cross-feature orchestration belongs in a program service`)
    visit(declaration, child => {
      if (ts.isPropertyAccessExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'ctx' && child.name.text in capabilities) {
        assert.ok(declared.includes(child.name.text), `${owner}: undeclared tool-adapter dependency ${child.name.text}`)
      }
    })
  }
})

test('workspace exports and imported export subpaths resolve to real implementation files', () => {
  const manifests = new Map(packageNames.map(name => [name, JSON.parse(readFileSync(join(packagesRoot, name, 'package.json'), 'utf8')) as { name: string; exports: Record<string, string> }]))
  for (const [name, manifest] of manifests) {
    assert.equal(manifest.name, `@merv/${name}`)
    assert.ok(manifest.exports['.'], `${name}: missing root export`)
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      assert.equal(typeof target, 'string', `${name}/${subpath}: unsupported export mapping; extend verification when introducing conditions`)
      assert.ok(target.startsWith('./') && !target.includes('..'), `${name}: export escapes package root`)
      if (target.includes('*')) {
        const [prefix, suffix] = target.slice(2).split('*')
        const matches = walkFiles(join(packagesRoot, name)).map(file => relative(join(packagesRoot, name), file)).filter(file => file.startsWith(prefix) && file.endsWith(suffix))
        assert.ok(matches.length > 0, `${name}/${subpath}: wildcard export has no implementation`)
      } else assert.ok(existsSync(join(packagesRoot, name, target)), `${name}/${subpath}: exported file does not exist`)
    }
  }
  const consumers = [...sourceFiles, ...walkFiles(join(root, 'src')), ...walkFiles(join(root, 'tests'))].filter(path => path.endsWith('.ts'))
  for (const path of consumers) for (const specifier of references(parse(path))) {
    if (!specifier.startsWith('@merv/')) continue
    const [, name, ...segments] = specifier.split('/')
    const manifest = manifests.get(name)
    assert.ok(manifest, `${relative(root, path)} references absent package ${name}`)
    const subpath = segments.length ? `./${segments.join('/')}` : '.'
    const target = manifest.exports[subpath] ?? (manifest.exports['./*'] && manifest.exports['./*'].replace('*', segments.join('/')))
    assert.ok(target && existsSync(join(packagesRoot, name, target)), `${relative(root, path)}: ${specifier} does not resolve to an exported file`)
  }
})

test('each service boots with only its declared dependency closure and without API or tools', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-independent-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const plugins: Record<string, { plugin: any; config?: any }> = {
    state: { plugin: statePlugin, config: { path: ':memory:' } },
    blobs: { plugin: blobsPlugin, config: { root: directory } },
    scope: { plugin: scopePlugin }, artifacts: { plugin: artifactsPlugin }, workflows: { plugin: workflowsPlugin },
    reviews: { plugin: reviewsPlugin }, tasks: { plugin: tasksPlugin }, feed: { plugin: feedPlugin },
  }
  for (const target of Object.keys(plugins)) await t.test(target, async () => {
    const required = new Set<string>()
    const include = (name: string) => { if (required.has(name)) return; required.add(name); for (const dependency of capabilities[name]) include(dependency) }
    include(target)
    const ctx = new Context()
    try {
      // Install the requested service first: activation must follow dependency availability.
      const fibers = []
      for (const name of required) fibers.push(await ctx.plugin(plugins[name].plugin, plugins[name].config))
      await Promise.all(fibers.map(fiber => fiber.await()))
      for (const name of Object.keys(capabilities)) assert.equal(!!ctx.get(name), required.has(name), `${target}: unexpected ${name} availability`)
      if (target === 'state') assert.equal(ctx.state.read(sql => sql.get<{ answer: number }>('SELECT 42 AS answer'))?.answer, 42)
      if (target === 'blobs') {
        const stored = ctx.blobs.put('isolated', Buffer.from('durable bytes'))
        assert.equal(ctx.blobs.get('isolated', stored.hash).toString(), 'durable bytes')
      }
      if (required.has('scope')) {
        const credentials = ctx.scope.bootstrap({ projectName: 'Independent component', actorName: 'Operator' })
        const caller = { actorId: credentials.actor.id, projectId: credentials.project.id }
        assert.equal(ctx.scope.project(caller).id, caller.projectId)
        if (target === 'workflows') {
          const program = ctx.workflows.register({ name: 'minimal', version: 1, initial: 'done', states: ['done'], terminal: ['done'], edges: [] })
          assert.equal(program.start(caller, { workflow: 'minimal', requestId: 'start' }).state, 'done')
        }
        if (required.has('artifacts')) {
          const artifact = ctx.artifacts.create(caller, { title: 'Brief', content: 'Goal: Run alone.\nCheck: The service works.' })
          assert.equal(ctx.artifacts.read(caller, artifact.id).content, 'Goal: Run alone.\nCheck: The service works.')
          if (target === 'reviews') assert.equal(ctx.reviews.request(caller, { subjectId: 'opaque-target', subjectRevision: 0, producerId: caller.actorId, artifactIds: [artifact.id], criteria: ['The service works.'], requestId: 'review' }).status, 'requested')
          if (target === 'tasks') assert.equal(ctx.tasks.create(caller, { title: 'Standalone task', goal: 'Run alone.', checks: ['The service works.'], briefId: artifact.id, requestId: 'task' }).workflow.state, 'in_progress')
          if (target === 'feed') assert.equal(ctx.feed.post(caller, { body: 'The service works.', artifactIds: [artifact.id], requestId: 'post' }).body, 'The service works.')
        }
      }
    } finally { await ctx.fiber.dispose() }
  })
})
