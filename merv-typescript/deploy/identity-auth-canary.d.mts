import type { Scope, State } from '@merv/contracts';

/** The release identity canary's single JSON line. */
export function runCanary(input: { state: State; scope: Scope; origin: string }): Promise<{
  result: 'pass';
  projectId: string;
  actorId: string;
  registration: 200;
  wrongProject: 403;
  oldAfterRotation: 401;
  rotatedSelf: 200;
  retiredSelf: 401;
  identityMigrationHash: string;
}>;
