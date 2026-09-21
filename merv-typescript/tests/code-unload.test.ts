import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import type { CodeProposal } from '@merv/code/types';
import type {
  Caller,
  CodeCommandRecord,
  CodeCommitReceipt,
  SessionWorkspace,
} from '@merv/contracts';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';

const oid = (digit: string) => digit.repeat(40);

test('Cordis Code removal withdraws its tools, controls and UI while commands, receipts and sealed proposals survive reload', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-code-unload-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  config.plugins = config.plugins.map((entry) =>
    entry.id === 'api'
      ? { ...entry, config: { host: '127.0.0.1', port: 0 } }
      : entry.id === 'ui'
        ? { ...entry, config: { assets: join(directory, 'unused-assets') } }
        : entry,
  );
  const app = await createApp({ directory: join(directory, 'data'), config });
  const client = new Client({ name: 'code-unload-test', version: '1' });
  t.after(async () => {
    await client.close();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Code reload', actorName: 'Owner' });
  const source: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const workflowName = 'code-reload-test';
  const program = await app.ctx.workflows.register(
    {
      name: workflowName,
      version: 1,
      initial: 'working',
      states: ['working', 'done'],
      terminal: ['done'],
      edges: [{ from: 'working', action: 'finish', to: 'done' }],
    },
    {
      actions: [
        {
          name: 'finish',
          states: ['working'],
          transitions: ['finish'],
          tool: 'finish',
          instruction: 'Finish.',
          check: async ({ caller, tx }) => {
            await app.ctx.scope.require(caller, 'write', tx);
          },
        },
      ],
      assignments: [
        {
          state: 'working',
          check: async ({ caller, tx }) => {
            await app.ctx.scope.require(caller, 'read', tx);
          },
          build: async () => ({
            role: 'producer',
            label: 'Code reload',
            brief: 'Commit the assigned checkout.',
            references: [],
            handoff: { instruction: 'Finish.', tools: [] },
            execution: { readOnly: false, tools: [] },
            context: null,
          }),
          execution: {
            readOnly: false,
            tools: [
              { name: 'code.commit', alternatives: [{}] },
              { name: 'code.operation', alternatives: [{}] },
              // Test-domain admission only; no production seal tool is added.
              { name: 'fixture.seal', alternatives: [{}] },
            ],
            workspace: {
              mode: 'persistent',
              namespace: 'reload',
              base: 'reference:code',
              perBase: true,
              retain: true,
              advancesCentral: false,
            },
          },
          references: () => ({ code: oid('a') }),
          lease: {
            role: async (): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> => 'producer',
            acquire: async () => ({}),
            check: async () => {},
            release: async () => {},
          },
        },
      ],
    },
  );
  const instance = await program.start(source, { workflow: workflowName, requestId: 'start' });
  const http = async (path: string, input: unknown) => {
    const response = await fetch(`${app.ctx.api.url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${boot.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const ok = async (path: string, input: unknown) => {
    const response = await http(path, input);
    assert.equal(response.status, 200, JSON.stringify(response));
    return response.body;
  };
  const secret = `ms_${randomBytes(32).toString('base64url')}`;
  const { session } = await ok('/sessions/offer', {
    instanceId: instance.id,
    expectedRevision: instance.revision,
    runnerId: 'runner',
    requestId: 'offer',
    secret,
  });
  const control = { sessionId: session.id, runnerId: 'runner', hostRef: 'launch' };
  // The runner attachment and receipt are synthetic observations: this test proves
  // transport/lifecycle persistence, not execution or verification of Git objects.
  const workspace: SessionWorkspace = {
    repositoryId: 'repository',
    workspaceId: 'workspace',
    mode: 'persistent',
    branch: 'codex/merv/reload',
    baseOid: oid('a'),
    headOid: oid('a'),
    stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
  };
  await ok(`/sessions/${session.id}/attach`, { runnerId: 'runner', hostRef: 'launch', workspace });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${app.ctx.api.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${secret}` } },
    }),
  );
  const invoke = async <T = CodeCommandRecord>(name: string, input: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: input });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    const text = (response.content as { type: string; text: string }[])[0];
    assert.equal(text.type, 'text');
    return JSON.parse(text.text) as T;
  };
  // Every native read is listed for a session; the catalog here is what this policy grants.
  const catalog = async () =>
    (await client.listTools()).tools
      .filter((tool) => !tool.annotations?.readOnlyHint || tool.name === 'code.operation')
      .map((tool) => tool.name)
      .sort();
  const rows = async () => (await ok('/tools/ui.shell', {})).result.rows as { id: string }[];
  const operations = async () =>
    (await ok('/tools/ui.read', { rowId: 'code' })).result.operations as CodeCommandRecord[];
  const proposals = async () =>
    (await ok('/tools/ui.read', { rowId: 'code' })).result.proposals as CodeProposal[];
  const input = {
    expectedHead: oid('a'),
    message: 'Preserve the exact request across reload.',
    requestId: 'commit',
  };
  assert.deepEqual(await catalog(), ['code.commit', 'code.operation']);
  // The unit tools are the project's, never a worker's: an actor key reads them and may not bind.
  // The default composition keeps repositories under the data directory; nothing is imported.
  const unbound = {
    project: null,
    store: {
      hosted: false,
      objectFormat: null,
      rootOid: null,
      source: null,
      tips: [],
      diskBytes: 0,
      quotaBytes: 10 * 1024 * 1024 * 1024,
      limits: { format: 1, denyGlobs: [], secretExemptGlobs: [] },
    },
    operations: [],
    mirror: {
      state: 'off',
      repository: null,
      blockedBy: 'github_unconfigured',
      pending: 0,
      oldestPendingAt: null,
      lastError: null,
      blockedRefs: [],
    },
    warnings: [],
    units: [],
    bases: [],
    blockers: [],
  };
  assert.deepEqual((await ok('/tools/code.status', {})).result, unbound);
  assert.deepEqual((await ok('/tools/ui.read', { rowId: 'code' })).result.status, unbound);
  assert.equal(
    (await http('/tools/code.unit.get', { unitId: instance.id })).body.error.code,
    'code_unit_not_found',
  );
  assert.equal(
    (
      await http('/tools/code.local.bind', {
        repositoryId: 'repository',
        mainOid: oid('a'),
        requestId: 'bind',
      })
    ).body.error.code,
    'code_human_required',
  );
  const queued = await invoke('code.commit', input);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.command.actorId, session.actorId);
  assert.deepEqual(await operations(), [queued]);
  const originalProvider = app.ctx.code;
  const originalSessions = app.ctx.sessions;
  const eventTypes = async () =>
    (await app.ctx.state.events(boot.project.id))
      .filter((event) => event.subjectId === queued.command.id)
      .map((event) => event.type);

  await app.setEnabled('code', false);
  assert.equal(app.status().find((entry) => entry.id === 'code')?.state, 'disabled');
  for (const id of ['code-tools', 'code-api', 'code-ui']) {
    const entry = app.status().find((entry) => entry.id === id);
    assert.equal(entry?.state, 'pending', id);
    assert.deepEqual(entry?.missingDependencies, ['code'], id);
  }
  for (const id of ['state', 'scope', 'sessions', 'workflows', 'api', 'ui'])
    assert.equal(app.status().find((entry) => entry.id === id)?.state, 'active', id);
  assert.equal(app.ctx.sessions, originalSessions);
  assert.equal((await app.ctx.sessions.get(source, session.id)).status, 'active');
  assert.deepEqual(await catalog(), []);
  assert.equal(
    (await rows()).some((row) => row.id === 'code'),
    false,
  );
  assert.equal((await http('/tools/ui.read', { rowId: 'code' })).body.error.code, 'row_unreadable');
  assert.equal(
    (await http('/tools/code.operation', { commandId: queued.command.id })).body.error.code,
    'unknown_tool',
  );
  assert.equal((await http('/tools/code.status', {})).body.error.code, 'unknown_tool');
  const absent = await http('/code/commands/next', control);
  assert.equal(absent.status, 503);
  assert.equal(absent.body.error.code, 'code_unavailable');
  await assert.rejects(async () => await originalProvider.operation(source, queued.command.id), {
    code: 'code_unavailable',
  });

  await app.setEnabled('code', true);
  assert.notEqual(app.ctx.code, originalProvider);
  assert.deepEqual(await catalog(), ['code.commit', 'code.operation']);
  assert.equal((await rows()).filter((row) => row.id === 'code').length, 1);
  assert.deepEqual(await operations(), [queued]);
  assert.deepEqual(await invoke('code.commit', input), queued);
  assert.deepEqual((await ok('/code/commands/next', control)).command, queued.command);
  assert.deepEqual((await ok('/code/commands/next', control)).command, queued.command);
  const receipt: CodeCommitReceipt = {
    commandId: queued.command.id,
    repositoryId: workspace.repositoryId,
    workspaceId: workspace.workspaceId,
    baseOid: workspace.baseOid,
    parentOid: queued.command.expectedHead,
    headOid: oid('b'),
    treeOid: oid('c'),
    stats: { commitCount: 1, filesChanged: 1, insertions: 2, deletions: 1 },
  };
  const completion = { ...control, commandId: queued.command.id, receipt };
  const finished = (await ok('/code/commands/complete', completion)).operation as CodeCommandRecord;
  assert.equal(finished.status, 'succeeded');
  assert.deepEqual(finished.receipt, receipt);

  // Admit a genuine MCP session command through the registry and create actual
  // worker-authored evidence. Only the Git attachment/receipt above is synthetic.
  const disposeSeal = app.ctx.tools.register({
    name: 'fixture.seal',
    description: 'Test-domain command that seals a successful assigned checkpoint.',
    inputSchema: z.object({ commandId: z.string().min(1) }).strict(),
    handler: async (caller, input) =>
      await app.ctx.state.transaction(async (tx) => {
        const evidence = await app.ctx.artifacts.create(
          caller,
          {
            title: 'Retained verification',
            content:
              'This fixture supplied a matching synthetic runner receipt; no real Git execution is claimed.',
          },
          tx,
        );
        return await app.ctx.code.seal(
          caller,
          {
            commandId: input.commandId,
            summary: 'Retain the exact checkpoint and evidence through Code reload.',
            artifactIds: [evidence.id],
            provenance: { fixture: 'code-unload' },
            requestId: 'seal',
          },
          { tool: 'fixture.seal', input },
          tx,
        );
      }),
  });
  let proposal: CodeProposal;
  try {
    proposal = await invoke<CodeProposal>('fixture.seal', { commandId: queued.command.id });
  } finally {
    await disposeSeal();
  }
  const proposalProvider = app.ctx.code;
  const manifest = await app.ctx.artifacts.read(source, proposal.manifestArtifact.id);
  assert.equal(manifest.encoding, 'utf8');
  const manifestHash = createHash('sha256').update(manifest.content).digest('hex');
  assert.equal(proposal.manifestHash, manifestHash);
  assert.equal(proposal.manifestArtifact.hash, manifestHash);
  assert.equal(proposal.producer.actorId, session.actorId);
  assert.equal(proposal.producer.sessionId, session.id);
  assert.equal(proposal.manifestArtifact.createdBy, session.actorId);
  assert.ok(proposal.artifacts.every((artifact) => artifact.createdBy === session.actorId));
  assert.deepEqual(proposal.receipt, receipt);
  assert.deepEqual(await proposals(), [proposal]);
  assert.deepEqual(await catalog(), ['code.commit', 'code.operation']);
  await app.setEnabled('code', false);
  await assert.rejects(async () => await proposalProvider.proposal(source, proposal.id), {
    code: 'code_unavailable',
  });
  await assert.rejects(async () => await proposalProvider.proposals(source), {
    code: 'code_unavailable',
  });
  await app.setEnabled('code', true);
  assert.notEqual(app.ctx.code, proposalProvider);
  assert.deepEqual(await app.ctx.code.proposal(source, proposal.id), proposal);
  assert.deepEqual(await app.ctx.code.proposals(source, instance.id), [proposal]);
  assert.deepEqual(await app.ctx.artifacts.read(source, proposal.manifestArtifact.id), manifest);
  assert.deepEqual(await proposals(), [proposal]);
  const sealedEvents = (await app.ctx.state.events(boot.project.id)).filter(
    (event) => event.type === 'code.proposal_sealed',
  );
  assert.equal(sealedEvents.length, 1);
  assert.equal(sealedEvents[0].subjectId, proposal.id);
  assert.equal(sealedEvents[0].data.manifestHash, manifestHash);
  assert.equal(sealedEvents[0].data.manifestArtifactId, proposal.manifestArtifact.id);
  t.diagnostic(`Reload preserved canonical proposal manifest SHA-256 ${manifestHash}`);
  assert.deepEqual(await invoke('code.operation', { commandId: queued.command.id }), finished);
  assert.deepEqual(await invoke('code.commit', input), finished);
  assert.deepEqual((await ok('/code/commands/complete', completion)).operation, finished);
  const conflict = await http('/code/commands/complete', {
    ...completion,
    receipt: { ...receipt, headOid: oid('d') },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'code_result_conflict');
  assert.deepEqual(await operations(), [finished]);
  assert.equal((await ok('/code/commands/next', control)).command, null);
  assert.deepEqual(await eventTypes(), [
    'code.command_queued',
    'code.command_dispatched',
    'code.command_succeeded',
  ]);
  assert.equal((await rows()).filter((row) => row.id === 'code').length, 1);
  assert.deepEqual(await catalog(), ['code.commit', 'code.operation']);
});
