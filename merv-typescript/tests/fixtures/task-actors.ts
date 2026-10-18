import type { Caller } from '@merv/contracts';
import type { createApp } from './app.js';

/** A new project's operator, and a producer, reviewer and reader with keys of their own. */
export async function taskActors(app: Awaited<ReturnType<typeof createApp>>, projectName: string) {
  const boot = await app.ctx.scope.credentials.bootstrap({ projectName, actorName: 'Operator' });
  const operator: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  /** Another actor of `role`, named after it. */
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => {
    const issued = await app.ctx.scope.credentials.issueActor(operator, { role, name: role });
    const caller: Caller = {
      actorId: issued.actor.id,
      projectId: boot.project.id,
      credentialId: issued.credential.id,
    };
    return { caller, token: issued.token };
  };
  const producer = await issue('producer'),
    reviewer = await issue('reviewer'),
    reader = await issue('reader');
  return { operator, issue, producer, reviewer, reader };
}
