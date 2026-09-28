import type { Migration } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import { membershipMigration } from './memberships.js';
import { projectContextMigration } from './project-context.js';
import { userKeyMigration } from './user-keys.js';

/** Scope's migrations, in version order. Production pins each text by its digest. */
export const scopeMigrations: Migration[] = [
  {
    version: 1,
    sql: postgresMigrations[1],
  },
  {
    version: 2,
    sql: postgresMigrations[2],
  },
  membershipMigration,
  userKeyMigration,
  {
    version: 5,
    sql: postgresMigrations[5],
  },
  projectContextMigration,
  {
    version: 7,
    sql: postgresMigrations[7],
  },
  {
    version: 8,
    sql: postgresMigrations[8],
  },
  {
    version: 9,
    sql: postgresMigrations[9],
  },
];
