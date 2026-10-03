import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  Transaction,
  WorkflowDependency,
  WorkflowExecutionPolicy,
  WorkflowPinned,
  WorkflowRelations,
  Workflows,
} from '@merv/contracts';
import { providerRelations } from '@merv/code-work/relations';

/**
 * Code-work's view of a unit's edges, composed over the engine's domain-free relations()
 * and pinned(). The engine's side of both reads is pinned in workflow-blockers.test.ts; this
 * pins only what code-work adds: each version's workspace fact. A unit's domain data is never
 * read; the generic name and id are all code-work knows of it.
 */

const tx = {} as Transaction;
const item = (id: string, workflow: string, extra: Partial<WorkflowDependency> = {}) => ({
  id,
  workflow,
  version: 1,
  name: workflow,
  state: 'building',
  revision: 0,
  settled: false,
  terminal: false,
  failed: false,
  ...extra,
});
const manifest = (mode?: 'ephemeral' | 'none'): WorkflowExecutionPolicy => ({
  readOnly: false,
  tools: [],
  ...(mode === 'none' ? { workspace: { mode } } : {}),
  ...(mode === 'ephemeral'
    ? { workspace: { mode, namespace: 'probe', base: 'central', retain: false } }
    : {}),
});
const contract = (execution: WorkflowPinned['execution']) =>
  ({ execution }) as unknown as WorkflowPinned;

/** The engine reads the fixtures hold, keyed by instance id and by `workflow@version`. */
const engine = (
  relations: Record<string, WorkflowRelations>,
  pinned: Record<string, WorkflowPinned>,
): Workflows =>
  ({
    relations: async (_projectId: string, id: string) => relations[id] ?? null,
    pinned: async (workflow: string, version: number) => pinned[`${workflow}@${version}`] ?? null,
  }) as unknown as Workflows;

test('a provider view adds each version’s workspace fact and never reads the domain’s data', async () => {
  const workflows = engine(
    {
      top: {
        instance: { ...item('top', 'build'), data: { goal: 'Ship the build', other: 1 } },
        dependencies: [
          item('plain', 'build', { kind: 'declared' }),
          item('git', 'coded', { kind: 'declared', settled: true, terminal: true }),
          item('none', 'bare', { kind: 'declared', settled: true, terminal: true }),
          item('gone', 'unpinned', { kind: 'declared' }),
          item('off', 'off', { kind: 'declared' }),
        ],
        dependents: [item('above', 'coded', { kind: 'declared' })],
      },
    },
    {
      'build@1': contract({ building: manifest() }),
      'coded@1': contract({ building: null, reviewing: manifest('ephemeral') }),
      // A terminal dependency whose version pins no manifest declares no workspace.
      'bare@1': contract({ building: null }),
      'off@1': contract({ building: manifest('none') }),
    },
  );

  const view = await providerRelations(workflows, 'project', 'top', tx);
  assert.ok(view);
  assert.deepEqual(view.instance, { ...item('top', 'build'), declaresWorkspace: false });
  assert.equal('data' in view.instance, false);
  assert.deepEqual(
    Object.fromEntries(view.dependencies.map((each) => [each.id, each.declaresWorkspace])),
    { plain: false, git: true, none: false, gone: false, off: false },
  );
  assert.deepEqual(
    view.dependents.map((each) => [each.id, each.declaresWorkspace]),
    [['above', true]],
  );

  assert.equal(await providerRelations(workflows, 'project', 'missing', tx), null);
});
