import { postgresMigrations } from './storage.postgres.js';
import type { State } from '@merv/contracts';

export async function migrateKnowledge(state: State): Promise<void> {
  await state.migrate(
    'knowledge',
    Object.entries(postgresMigrations).map(([version, sql]) => ({ version: +version, sql })),
  );
}
