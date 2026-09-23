import { createService } from '@merv/contracts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { RecipeContextBuilder } from '@merv/context-builder';
import { ReviewService } from '@merv/reviews';
import { TaskService } from '@merv/tasks';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { openState } from './state.js';

/** The owner services without a listener, so their transaction tests also run in a sandbox. */
export async function resolutionFixture(
  t: TestContext,
  versions: { workflows?: number; scope?: number; reviews?: number; human?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-resolution-'));
  const state = await openState();
  const migrate = state.migrate.bind(state);
  state.migrate = async (component, migrations) => {
    const version =
      component === 'scope'
        ? versions.scope
        : component === 'workflows'
          ? versions.workflows
          : component === 'reviews'
            ? versions.reviews
            : undefined;
    return migrate(
      component,
      version === undefined ? migrations : migrations.filter((item) => item.version <= version),
    );
  };
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  state.migrate = migrate;
  const context = await createService(new RecipeContextBuilder(state, scope, artifacts));
  const tasks = await createService(
    new TaskService(state, scope, artifacts, workflows, reviews, context),
  );
  const events = await createService(new DurableEvents(state));
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, { sweepIntervalMs: 60_000 }),
  );
  const beforeClose: (() => void | Promise<void>)[] = [];
  t.after(async () => {
    for (const close of beforeClose) await close();
    tasks.dispose();
    await sessions.close();
    await events.close();
    workflows.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const admin = await (async () => {
    if (versions.human) {
      const principal = await scope.acceptVerifiedIdentity({
        issuer: 'https://identity.example/auth/v1',
        subject: 'owner',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      const project = await scope.createProject(principal, {
        name: 'Resolution',
        requestId: 'project',
      });
      return await scope.caller(principal, project.id);
    }
    const boot = await scope.bootstrap({ projectName: 'Resolution', actorName: 'Owner' });
    return { projectId: boot.project.id, actorId: boot.actor.id };
  })();
  return {
    directory,
    state,
    scope,
    workflows,
    artifacts,
    reviews,
    context,
    tasks,
    events,
    sessions,
    admin,
    beforeClose,
  };
}
