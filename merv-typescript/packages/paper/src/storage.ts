import { postgresMigrations } from './storage.postgres.js';
import type { State } from '@merv/contracts';
export async function migratePaper(state: State): Promise<void> {
  await state.migrate(
    'paper',
    Object.entries(postgresMigrations).map(([version, sql]) => ({ version: +version, sql })),
  );
}
