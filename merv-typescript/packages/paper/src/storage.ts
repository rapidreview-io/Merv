import { postgresMigrations } from './storage.postgres.js';
import type { State } from '@merv/contracts';
export async function migratePaper(state: State): Promise<void> {
  await state.migrate('paper', [
    {
      version: 1,
      sql: postgresMigrations[1],
    },
    {
      version: 2,
      sql: postgresMigrations[2],
    },
  ]);
}
