/** Cycle 11 review: a refused cycle move is checked again while it waits. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { serve, settle, unmount } from './ui-render.js';
import { graph, now, open } from './ui-records.js';

const { ResearchView } = await import('../packages/ui/web/views/research.js');

/**
 * A cycle whose gate refuses while it waits on something its page's check-free read does not
 * show (its consolidation's code reaching main) must not keep that refusal on screen forever:
 * nothing about the cycle or its work moves when the wait ends.
 */
test('a refused cycle move is checked again while it waits, though nothing on the page moves', async (t) => {
  t.after(unmount);
  let ready = false;
  const record = {
    id: 'wf_1',
    name: 'Grokking cycle',
    ownerId: 'actor_1',
    workflow: { workflow: 'research', state: 'consolidating', revision: 4, updatedAt: now },
    researchDependencies: [],
    reflectionId: null,
    integrations: [],
    writable: true,
    automation: null,
    progress: { settled: 1, total: 1 },
  };
  serve('/tools/ui.read', () => ({
    body: { result: { record, process: { ...graph('consolidating', false), revision: 4 } } },
  }));
  serve('/tools/workflow.status_and_next', () => ({
    body: {
      result: {
        instanceId: 'wf_1',
        revision: 4,
        terminal: false,
        actions: [
          {
            action: 'advance',
            tool: 'research.write',
            arguments: { action: 'advance', advance: {} },
            status: ready ? 'ready' : 'blocked',
            blockers: ready
              ? []
              : [{ code: 'dependencies_pending', message: 'Waiting for the consolidation code' }],
            requiredInput: [],
          },
        ],
        blockers: [],
        dependencies: [],
      },
    },
  }));
  await open('/research/wf_1', ResearchView);
  const button = () =>
    [...document.querySelectorAll('button')].find((each) =>
      each.textContent!.includes('Start next step'),
    );
  assert.ok(button(), 'the move is drawn');
  assert.equal(button()!.disabled, true, 'refused while it waits');
  // The consolidation's code reaches main: the gate would now let the cycle move.
  ready = true;
  await settle(31_000);
  assert.equal(button()!.disabled, false, 'the move opens once the gate does');
});
