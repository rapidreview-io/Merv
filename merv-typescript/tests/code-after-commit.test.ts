import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { MainLanding } from '../packages/code-work/src/landing.js';
import { CodeBaseService } from '../packages/code-work/src/bases.js';
import { openState } from './fixtures/state.js';

for (const kind of ['landing', 'base'] as const) {
  test(`${kind} wakeup reads fresh state after commit and is discarded on rollback`, async (t) => {
    const state = await openState();
    // Work itself is independent of scheduling; observe the database scope it receives.
    const service =
      kind === 'landing'
        ? new MainLanding(state, null!, null!, null!, true)
        : new CodeBaseService(state, null!, null!);
    const observed: unknown[] = [];
    t.mock.method(service, 'work', async () => {
      try {
        observed.push(await state.read((sql) => sql.get('SELECT 1 AS value')));
      } catch (error) {
        observed.push((error as { code: string }).code);
      }
    });
    await state.transaction(async () => {
      service.soon('project');
      await delay(100);
      assert.deepEqual(observed, [], 'work must not run before commit');
    });
    await delay(100);
    assert.deepEqual(observed, [{ value: 1 }]);
    await assert.rejects(
      state.transaction(async () => {
        service.soon('project');
        throw new Error('rollback');
      }),
      /rollback/,
    );
    await delay(100);
    assert.deepEqual(observed, [{ value: 1 }], 'rolled-back work must not wake');
    // The common short transaction has already retired by the time the timer fires.
    await state.transaction(async () => service.soon('project'));
    await delay(100);
    assert.deepEqual(observed, [{ value: 1 }, { value: 1 }]);
  });
}
