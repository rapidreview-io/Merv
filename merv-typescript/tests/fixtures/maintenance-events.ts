import assert from 'node:assert/strict';
import { PostgresState } from '@merv/state';
import { DurableEvents } from '@merv/domain-events';
import { createService } from '@merv/contracts';
import { bootMaintenance } from '@merv/contracts/maintenance';
const state = await PostgresState.open({
  connectionString: process.env.MERV_TEST_POSTGRES_URL!,
  schema: process.env.MAINTENANCE_TEST_SCHEMA!,
});
const events = await createService(new DurableEvents(state));
try {
  await events.subscribe({
    id: 'maintenance.probe',
    types: ['probe.created'],
    from: 'now',
    handle: async (event, tx) => {
      await tx.run('INSERT INTO maintenance_probe(event) VALUES(?)', event.id);
    },
  });
  if (bootMaintenance.active) {
    await state.transaction((tx) =>
      state.appendEvent(tx, {
        projectId: 'p',
        actorId: 'a',
        subjectId: 'two',
        type: 'probe.created',
        data: {},
      }),
    );
    await events.drain();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await events.drain();
    assert.equal((await state.read((sql) => sql.all('SELECT * FROM maintenance_probe'))).length, 0);
  } else {
    await events.drain();
    assert.equal((await state.read((sql) => sql.all('SELECT * FROM maintenance_probe'))).length, 2);
  }
  console.log('verified');
} finally {
  await events.close();
  await state.close();
}
