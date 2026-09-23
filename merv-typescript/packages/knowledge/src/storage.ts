import { postgresMigrations } from './storage.postgres.js';
import type { State } from '@merv/contracts';

export async function migrateKnowledge(state: State): Promise<void> {
  await state.migrate('knowledge', [
    {
      version: 1,
      sql: postgresMigrations[1],
    },
  ]);
}
