import { CodeService as CoreCodeService } from '@merv/code/service';
import { CodeService } from '@merv/code-work/service';
import type { CodeCapture } from '@merv/code-work/types';
import { CodeRepositories } from '@merv/code/store/repository';
import { createService } from '@merv/contracts';
import type { WorkflowSnapshot } from '@merv/workflows/models';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { CodeBaseService } from '../../packages/code-work/src/bases.js';
import { boundProject, codeConfig } from './code-binding.js';
import { git, gitSource } from './code-store.js';
import { resolutionFixture } from './resolution.js';
import { assessment } from './review-verdict.js';

/**
 * A project Code hosts, with its own repositories and the GitHub App faked at its seam, where
 * ordinary units of work are accepted and one of them publishes its accepted code to main.
 */
export async function codePublishFixture(
  t: TestContext,
  connected = false,
  human = connected,
  importFailures = 0,
  options: { mainLanding?: boolean } = {},
) {
  const f = await resolutionFixture(t, { human });
  await f.sessions.dispatch.setDispatch(f.admin, { enabled: true });
  const root = join(f.directory, 'code');
  mkdirSync(join(root, 'tmp'), { recursive: true });
  mkdirSync(join(root, 'empty-template'));
  const repositories = new CodeRepositories({ root, quotaBytes: 1024 ** 3, reservedFreeBytes: 1 });
  await repositories.ensure(f.admin.projectId, 'repository', 'sha1');
  const branches = new Map<string, string>();
  const legacyCore = await createService(
    new CoreCodeService(f.state, f.scope, codeConfig(join(f.directory, 'legacy-code'))),
  );
  const legacy = await createService(
    new CodeService(f.state, f.scope, f.sessions, f.workflows, f.reviews, legacyCore),
  );
  await legacy.close();
  await legacyCore.close();
  const source = gitSource(t);
  const bare = repositories.paths(f.admin.projectId).repository;
  const root0 = source.commit({ 'shared.txt': 'root\n', 'own.txt': 'root\n' });
  const feature = source.commit({ 'own.txt': 'feature\n' });
  source.git('checkout', '--detach', root0);
  const moved = source.commit({ 'shared.txt': 'moved\n' });
  source.git('checkout', '--detach', root0);
  const clashing = source.commit({ 'own.txt': 'clashing\n' });
  const publish = (name: string, commit: string) =>
    source.git('push', bare, `${commit}:refs/heads/${name}`);
  for (const [name, commit] of Object.entries({ root0, feature, moved, clashing }))
    publish(name, commit);
  await boundProject(f.state, f.admin.projectId, root0, 'repository');
  const core = await createService(
    new CoreCodeService(f.state, f.scope, {
      repositories: { root, quotaBytes: 10 * 1024 ** 3, reservedFreeBytes: 1 },
    }),
  );
  const code = await createService(
    new CodeService(f.state, f.scope, f.sessions, f.workflows, f.reviews, core, {}, options),
  );
  const bases = (code as unknown as { baseStore: CodeBaseService }).baseStore;
  const setMain = async (oid: string) =>
    await f.state.transaction((tx) =>
      tx.run(
        'UPDATE code_projects SET store_json=?,main_json=? WHERE project_id=?',
        JSON.stringify({ format: 1, objectFormat: 'sha1', rootOid: root0 }),
        JSON.stringify({
          oid,
          operationId: 'fixture',
          admittedBy: 'fixture',
          admittedAt: 'now',
          stored: true,
        }),
        f.admin.projectId,
      ),
    );
  await setMain(root0);
  branches.set('main', root0);
  const handle = await f.workflows.register(
    {
      name: 'input',
      version: 1,
      managed: true,
      initial: 'working',
      states: ['working', 'done'],
      terminal: ['done'],
      edges: [{ from: 'working', action: 'accept', to: 'done' }],
    },
    {
      successStates: ['done'],
      actions: [
        {
          name: 'accept',
          tool: 'input.accept',
          instruction: 'Accept.',
          states: ['working'],
          transitions: ['accept'],
          check: () => {},
        },
      ],
    },
  );
  let sequence = 0;
  const id = () => `request-${++sequence}`;
  const producer = {
    projectId: f.admin.projectId,
    actorId: (await f.scope.credentials.issueActor(f.admin, { name: 'Producer', role: 'operator' }))
      .actor.id,
  };
  const captures = new Map<string, CodeCapture>();
  const original = code.capture.bind(code);
  t.mock.method(code, 'capture', async (...args: Parameters<CodeService['capture']>) =>
    args[1].kind === 'code-commit' && captures.has(args[1].commandId!)
      ? captures.get(args[1].commandId!)!
      : original(...args),
  );
  const declare = async (name: string, dependsOn: string[] = []) => {
    const work = await handle.start(f.admin, {
      workflow: 'input',
      dependsOn,
      requestId: id(),
      data: { title: name, goal: `Deliver ${name}` },
    });
    await f.state.transaction((tx) => code.declareUnit(f.admin, work.id, tx));
    return work;
  };
  const publishes = (work: WorkflowSnapshot) =>
    f.state.transaction((tx) => code.publishOnAcceptance(f.admin, { unitId: work.id }, tx));
  const pin = (work: WorkflowSnapshot) =>
    f.state.transaction((tx) =>
      code.pinBase(f.admin, { unitId: work.id, leaseId: `lease-${work.id}`, writer: false }, tx),
    );
  const move = (work: WorkflowSnapshot) =>
    handle.transition(f.admin, {
      instanceId: work.id,
      action: 'accept',
      expectedRevision: work.revision,
      requestId: `accept-${work.id}`,
    });
  const reviewed = async (work: WorkflowSnapshot) => {
    const evidence = await f.artifacts.create(producer, {
      title: 'Evidence',
      content: 'The delivered change was checked against its goal.',
    });
    const request = await f.reviews.request(producer, {
      subjectId: work.id,
      subjectRevision: work.revision,
      producerId: producer.actorId,
      artifactIds: [evidence.id],
      criteria: ['The change works.'],
      requestId: `review-${work.id}`,
    });
    const claim = await f.reviews.start(f.admin, request.id);
    await f.reviews.submit(f.admin, {
      reviewId: request.id,
      claimId: claim.claimId!,
      verdict: 'pass',
      notes: 'Checked the delivered change.',
      ...assessment(claim),
      requestId: `pass-${request.id}`,
    });
    return request.id;
  };
  /**
   * Acceptance as a passing review leaves it: an admitted upload, then the owner's record.
   * `admitted: false` leaves out the upload, as a commit Code never admitted.
   */
  const accept = async (work: WorkflowSnapshot, commit: string, admitted = true) => {
    const commandId = `capture-${work.id}`;
    captures.set(commandId, {
      ref: { kind: 'code-commit', commandId },
      status: 'ready',
      provenance: {
        projectId: f.admin.projectId,
        instanceId: work.id,
        readOnly: false,
      } as CodeCapture['provenance'],
      workspace: {
        repositoryId: 'repository',
        workspaceId: work.id,
        mode: 'persistent',
        branch: null,
        baseOid: root0,
        headOid: commit,
        treeOid: git(bare, ['rev-parse', `${commit}^{tree}`]),
        stats: { commitCount: 1, filesChanged: 1, insertions: 1, deletions: 0 },
      },
      observedAt: 'now',
      eventId: null,
    });
    const reviewId = await reviewed(work);
    const done = await move(work);
    if (admitted)
      await f.state.transaction(async (tx) => {
        await tx.run(
          "UPDATE code_workspaces SET generation=1,writer_state='closed',head_oid=? WHERE project_id=? AND unit_id=?",
          commit,
          f.admin.projectId,
          work.id,
        );
        await tx.run(
          "INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at,unit_id) VALUES (?,?,'fixture',?,'upload','hash','{}','completed',?,'now','now',?)",
          commandId,
          f.admin.projectId,
          commandId,
          JSON.stringify({ head: commit }),
          work.id,
        );
      });
    return await f.state.transaction((tx) =>
      code.acceptUnit(
        f.admin,
        {
          unitId: work.id,
          terminalRevision: done.revision,
          submissionRef: commandId,
          reviewRef: reviewId,
          codeRef: { kind: 'code-commit', commandId },
          reviewSessionId: null,
        },
        tx,
      ),
    );
  };
  const blockers = async (unitId: string) =>
    (await f.workflows.blockers(f.admin, unitId)).filter((item) => item.provider === 'code');
  const sync = async () => {
    await f.state.transaction((tx) => tx.run("UPDATE code_publications SET synced_at=''"));
    return await code.syncPublications(f.admin);
  };
  const unbind = f.bindCode(code);
  f.beforeClose.push(async () => {
    unbind();
    await code.close();
    await core.close();
    repositories.git.close();
  });
  return {
    ...f,
    code,
    bases,
    branches,
    repositories,
    bare,
    source,
    root0,
    feature,
    moved,
    clashing,
    setMain,
    publishGitRef: publish,
    declare,
    publishes,
    pin,
    move,
    accept,
    blockers,
    sync,
    id,
  };
}
