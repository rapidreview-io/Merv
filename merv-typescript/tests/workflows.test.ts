import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { SqliteState, statePlugin } from '@merv/state'
import { ProjectScope, scopePlugin } from '@merv/scope'
import { WorkflowsService, workflowsPlugin } from '@merv/workflows'
import type { Caller, WorkflowDefinition } from '@merv/contracts'

const graph = (version = 1): WorkflowDefinition => ({
  name: 'approval', version, initial: 'draft', states: ['draft', 'review', 'done'], terminal: ['done'],
  edges: [
    { from: 'draft', action: 'submit', to: 'review' },
    { from: 'review', action: 'revise', to: 'draft' },
    { from: 'review', action: 'accept', to: 'done' },
  ],
})
function setup(path = ':memory:') {
  const state = new SqliteState(path)
  const scope = new ProjectScope(state)
  const credentials = scope.bootstrap({ projectName: 'Workflow tests', actorName: 'Operator' })
  const caller = { actorId: credentials.actor.id, projectId: credentials.project.id }
  const workflows = new WorkflowsService(state, scope)
  workflows.register(graph())
  return { state, scope, workflows, caller }
}
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected

test('durable graph transitions record exact command responses, history, and events once', t => {
  const { state, workflows, caller } = setup()
  t.after(() => state.close())
  const start = { workflow: 'approval', requestId: 'start-1', data: { title: 'A', untouched: 1 } }
  const initial = workflows.start(caller, start)
  assert.equal(initial.revision, 0)
  const command = { instanceId: initial.id, expectedRevision: 0, action: 'submit', requestId: 'submit-1', data: { submitted: true } }
  const submitted = workflows.transition(caller, command)
  assert.equal(submitted.state, 'review')
  assert.deepEqual(submitted.data, { title: 'A', untouched: 1, submitted: true })
  const finished = workflows.transition(caller, { instanceId: initial.id, expectedRevision: 1, action: 'accept', requestId: 'accept-1' })
  assert.equal(finished.state, 'done')
  assert.deepEqual(workflows.start(caller, start), initial)
  assert.deepEqual(workflows.transition(caller, command), submitted)
  assert.equal(workflows.get(caller, initial.id).revision, 2)
  assert.equal(workflows.history(caller, initial.id).length, 3)
  assert.equal(state.events(caller.projectId).filter(event => event.type === 'workflow.transition').length, 3)
  assert.throws(() => workflows.transition(caller, { ...command, requestId: 'new', expectedRevision: 2 }), code('invalid_transition'))
  assert.throws(() => workflows.transition(caller, { ...command, data: { changed: true } }), code('request_conflict'))
  assert.throws(() => workflows.start(caller, { ...start, data: { title: 'Different' } }), code('request_conflict'))
  assert.throws(() => workflows.transition(caller, { ...command, requestId: 'start-1' }), code('request_conflict'))
})

test('versions are pinned and changed declarations are rejected across restart', t => {
  const folder = mkdtempSync(join(tmpdir(), 'merv-workflow-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const path = join(folder, 'state.sqlite')
  const first = setup(path)
  const initial = first.workflows.start(first.caller, { workflow: 'approval', requestId: 'start' })
  const secondGraph = graph(2)
  secondGraph.edges[0].action = 'send'
  first.workflows.register(secondGraph)
  assert.equal(first.workflows.start(first.caller, { workflow: 'approval', requestId: 'start-v2' }).version, 2)
  first.state.close()

  const state = new SqliteState(path)
  t.after(() => state.close())
  const workflows = new WorkflowsService(state, new ProjectScope(state))
  const changed = graph()
  changed.edges[0].action = 'send'
  assert.throws(() => workflows.register(changed), code('workflow_version_conflict'))
  workflows.register(graph())
  workflows.register(secondGraph)
  assert.equal(workflows.transition(first.caller, { instanceId: initial.id, action: 'submit', expectedRevision: 0, requestId: 'after-restart' }).version, 1)
  assert.deepEqual(workflows.start(first.caller, { workflow: 'approval', requestId: 'start' }), initial)
  assert.equal(workflows.history(first.caller, initial.id).length, 2)
})

test('competing connections reject stale revisions and transaction rollback includes ledger and events', t => {
  const folder = mkdtempSync(join(tmpdir(), 'merv-workflow-cas-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const path = join(folder, 'state.sqlite')
  const { state, scope, workflows, caller } = setup(path)
  t.after(() => state.close())
  const state2 = new SqliteState(path)
  t.after(() => state2.close())
  const other = new WorkflowsService(state2, new ProjectScope(state2))
  other.register(graph())
  const initial = workflows.start(caller, { workflow: 'approval', requestId: 'start' })
  const stale = other.get(caller, initial.id)
  workflows.transition(caller, { instanceId: initial.id, action: 'submit', expectedRevision: 0, requestId: 'winner' })
  assert.throws(() => other.transition(caller, { instanceId: initial.id, action: 'submit', expectedRevision: stale.revision, requestId: 'loser' }), code('revision_conflict'))
  const eventCount = state.events(caller.projectId).length
  const retry = { instanceId: initial.id, action: 'accept', expectedRevision: 1, requestId: 'rollback' }
  assert.throws(() => state.transaction(tx => {
    workflows.transition(caller, retry, tx)
    throw new Error('Caller-owned operation failed')
  }), /Caller-owned operation failed/)
  assert.equal(workflows.get(caller, initial.id).revision, 1)
  assert.equal(workflows.history(caller, initial.id).length, 2)
  assert.equal(state.events(caller.projectId).length, eventCount)
  assert.equal(workflows.transition(caller, retry).revision, 2)
  assert.throws(() => state2.transaction(tx => workflows.get(caller, initial.id, tx)), code('invalid_transaction'))
  assert.ok(scope.project(caller))
})

test('all project reads and mutation replays check actor scope and permission', t => {
  const { state, scope, workflows, caller } = setup()
  t.after(() => state.close())
  const initial = workflows.start(caller, { workflow: 'approval', requestId: 'start' })
  const foreign = scope.bootstrap({ projectName: 'Other', actorName: 'Other operator' })
  const other: Caller = { actorId: foreign.actor.id, projectId: foreign.project.id }
  assert.throws(() => workflows.get(other, initial.id), code('not_found'))
  assert.throws(() => workflows.history(other, initial.id), code('not_found'))
  assert.equal(workflows.list(other).length, 0)
  assert.throws(() => workflows.get({ ...other, projectId: caller.projectId }, initial.id), code('forbidden'))
  const reader = scope.issueActor(caller, { name: 'Reader', role: 'reader' }).actor
  const readerCaller = { actorId: reader.id, projectId: caller.projectId }
  assert.equal(workflows.get(readerCaller, initial.id).id, initial.id)
  assert.throws(() => workflows.start(readerCaller, { workflow: 'approval', requestId: 'start' }), code('forbidden'))
  const producer = scope.issueActor(caller, { name: 'Producer', role: 'producer' }).actor
  assert.throws(() => workflows.start({ actorId: producer.id, projectId: caller.projectId }, { workflow: 'approval', requestId: 'start' }), code('request_conflict'))
  scope.revokeActor(caller, producer.id)
  assert.throws(() => workflows.list({ actorId: producer.id, projectId: caller.projectId }), code('forbidden'))
})

test('managed program handles prevent bypass and disposal preserves durable data', t => {
  const { state, scope, workflows, caller } = setup()
  t.after(() => state.close())
  const definition = { ...graph(), name: 'owned', managed: true }
  const program = workflows.register(definition)
  const initial = program.start(caller, { workflow: 'owned', requestId: 'owned-start' })
  assert.throws(() => workflows.start(caller, { workflow: 'owned', requestId: 'bypass-start' }), code('workflow_managed'))
  assert.throws(() => workflows.transition(caller, { instanceId: initial.id, action: 'submit', expectedRevision: 0, requestId: 'bypass-transition' }), code('workflow_managed'))
  assert.throws(() => program.transition(caller, { instanceId: workflows.start(caller, { workflow: 'approval', requestId: 'other-start' }).id, action: 'submit', expectedRevision: 0, requestId: 'other-transition' }), code('workflow_handle_mismatch'))
  program.transition(caller, { instanceId: initial.id, action: 'submit', expectedRevision: 0, requestId: 'owned-submit' })
  const reviewer = scope.issueActor(caller, { name: 'Reviewer', role: 'reviewer' }).actor
  // A program may authorize a reviewer for its own action; generic engine writes remain forbidden.
  const reviewerCaller = { actorId: reviewer.id, projectId: caller.projectId }
  scope.require(reviewerCaller, 'review')
  const accepted = program.transition(reviewerCaller, { instanceId: initial.id, action: 'accept', expectedRevision: 1, requestId: 'owned-accept' })
  assert.equal(accepted.revision, 2)
  program.dispose()
  program.dispose()
  assert.equal(workflows.get(caller, initial.id).state, 'done')
  assert.throws(() => program.start(caller, { workflow: 'owned', requestId: 'disposed' }), code('workflow_unavailable'))
  const replacement = workflows.register(definition)
  assert.deepEqual(replacement.start(caller, { workflow: 'owned', requestId: 'owned-start' }), initial)
  program.dispose() // An old disposer cannot remove the replacement.
  assert.ok(workflows.catalog().some(item => item.name === 'owned'))
})

test('graph validation and defensive copies prevent changing installed behavior', t => {
  const { state, workflows, caller } = setup()
  t.after(() => state.close())
  const mutable = { ...graph(), name: 'mutable' }
  workflows.register(mutable)
  mutable.edges[0].action = 'sneaky'
  workflows.catalog().find(item => item.name === 'mutable')!.edges[0].action = 'another'
  const initial = workflows.start(caller, { workflow: 'mutable', requestId: 'start' })
  assert.equal(workflows.transition(caller, { instanceId: initial.id, action: 'submit', expectedRevision: 0, requestId: 'submit' }).state, 'review')
  assert.throws(() => workflows.register({ ...graph(), name: 'invalid', terminal: ['missing'] }), /terminal states/)
  assert.throws(() => workflows.register({ ...graph(), name: 'invalid', states: [...graph().states, 'unreachable'] }), /reachable/)
  assert.throws(() => workflows.start(caller, { workflow: 'approval', requestId: '', data: {} }), code('invalid_request'))
  assert.throws(() => workflows.start(caller, { workflow: 'approval', requestId: 'nan', data: { value: NaN } }), /finite JSON/)
})

test('real Cordis dependency activation and disposal preserve database state', async t => {
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose() })
  const workflowFiber = await ctx.plugin(workflowsPlugin)
  assert.equal(ctx.get('workflows'), undefined)
  await ctx.plugin(statePlugin, { path: ':memory:' })
  const scopeFiber = await ctx.plugin(scopePlugin)
  await workflowFiber.await()
  assert.ok(ctx.workflows)
  const scope = ctx.scope
  const credential = scope.bootstrap({ projectName: 'Cordis', actorName: 'Operator' })
  const caller = { actorId: credential.actor.id, projectId: credential.project.id }
  const service = ctx.workflows
  service.register(graph())
  const initial = service.start(caller, { workflow: 'approval', requestId: 'cordis' })
  await scopeFiber.dispose()
  assert.equal(ctx.get('workflows'), undefined)
  assert.throws(() => service.get(caller, initial.id), code('workflow_unavailable'))
  await ctx.plugin(scopePlugin)
  await workflowFiber.await()
  ctx.workflows.register(graph())
  assert.deepEqual(ctx.workflows.get(caller, initial.id), initial)
})
