/**
 * The founder's ruling of 2026-10-20 lets an admin's agent act as its person without approval. What
 * mints, rotates, reveals or reads a credential stays the signed-in person's: an agent holding their
 * key (one made on the Keys page or one their connector got by emailed code), a leased worker they
 * delegated, and their Pi conversation are each refused at every handler.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import { Context } from 'cordis';
import { z } from 'zod';
import {
  createService,
  MervError,
  sha256Hex,
  type ArtifactUploadStatus,
  type AgentLoginLimits,
  type Caller,
  type Principal,
  type SessionToolPolicy,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { scopeRoutes } from '@merv/scope/api';
import { scopeToolsPlugin } from '@merv/scope/tools';
import { mervRefusals } from '@sandboxes/merv-host/errors';
import { MervService } from '@sandboxes/merv-host/merv';
import type { ApiPrincipal, ApiRequest, MountHandler } from '@merv/api/types';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { CodeGitHubService } from '../packages/code/src/github.js';
import { conversationRules } from '../packages/pi/src/conversation-rules.js';
import { secretsRoutes } from '../packages/secrets/src/api.js';
import type { Secrets } from '../packages/secrets/src/types.js';
import { adminRoutes } from './fixtures/admin.js';
import { createApp } from './fixtures/app.js';
import { s3Blobs, send } from './fixtures/s3-blobs.js';
import { openState, stateConfig } from './fixtures/state.js';

const issuer = 'https://identity.example/auth/v1';
const refused = (code: string, status: number) => (error: unknown) =>
  error instanceof MervError && error.code === code && error.status === status;
const agentLimits: AgentLoginLimits = {
  emailPer15Minutes: 9,
  emailPerDay: 9,
  ipPerHour: 9,
  globalPerMinute: 30,
  globalPerDay: 500,
  triesPerLogin: 5,
  keysPerPerson: 10,
  keyDays: 90,
  retentionDays: 30,
};
const directory = {
  find: async () => ({ issuer, subject: 'alice' }),
  user: async () => ({
    email: 'alice@lab.org',
    anonymous: false,
    confirmed: true,
    banned: false,
    deleted: false,
  }),
};

async function fixture(t: TestContext) {
  const state = await openState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const alice = await scope.members.acceptVerifiedIdentity({
    issuer,
    subject: 'alice',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const project = await scope.members.createProject(alice, { name: 'Locked', requestId: 'lock' });
  const person = await scope.caller(alice, project.id);
  const source = await scope.delegationSource(person);
  // Her key, a worker she delegated and her conversation: the three agents that act for her.
  const issued = await scope.userKeys.create(alice, { projectId: project.id });
  const keyPrincipal: Principal = {
    kind: 'key',
    key: await scope.userKeys.authenticate(issued.token),
  };
  const key: Caller = { ...(await scope.caller(keyPrincipal)), projectId: project.id };
  /** A login her connector starts by email; `verify` is the one way it yields a key. */
  const login = async () => {
    const verifier = `verifier-${Math.random()}`;
    const started = await scope.agentLogins.start(
      {
        email: 'alice@lab.org',
        ip: null,
        client: { name: 'Claude Code', host: 'laptop', installId: crypto.randomUUID() },
        verifierHash: createHash('sha256').update(verifier).digest('base64url'),
      },
      agentLimits,
    );
    await scope.agentLogins.deliver(started, 'alice@lab.org', directory, async () => {});
    const verify = (code = started.code) =>
      scope.agentLogins.verify(
        started.loginId,
        { code, verifier },
        agentLimits,
        directory,
        async () => {},
      );
    return { started, verify };
  };
  // The account key her agent got by emailed code: refused wherever any key is.
  const emailed = await (await login()).verify();
  const emailPrincipal: Principal = {
    kind: 'key',
    key: await scope.userKeys.authenticate(emailed.token),
  };
  const emailKey = await scope.caller(emailPrincipal, project.id);
  const worker = await state.transaction((tx) =>
    scope.createSessionActor(
      source,
      { threadId: 'thread_lock', name: 'Worker', role: 'producer' },
      tx,
    ),
  );
  const session: Caller = {
    actorId: worker.id,
    projectId: project.id,
    session: { id: 'session_lock', threadId: 'thread_lock' },
  };
  const conversation: Caller = {
    actorId: person.actorId,
    projectId: project.id,
    conversation: { id: 'conversation_lock', epoch: 1, commandId: 'turn', runtimeId: 'runtime' },
  };
  scope.registerSessionAuthority({ require: async () => ({ source }) });
  scope.registerConversationAuthority({ require: async () => source });
  const tools = new ToolRegistry(scope, scope.toolPolicy);
  tools.registerCallerRules('conversation', conversationRules);
  // Workers may call whatever their assignment grants; Scope alone decides these tools.
  tools.registerSessionPolicy({
    allowsTool: async () => true,
    prepare: async (caller, tool, input) => ({ caller, tool, input }),
    validate: async () => {},
    cancel: () => {},
    run: async (invocation, handler) => await handler(invocation.caller, invocation.input),
  } satisfies SessionToolPolicy);
  const ctx = new Context();
  ctx.provide('scope', scope);
  ctx.provide('tools', tools);
  await ctx.plugin(scopeToolsPlugin);
  t.after(async () => {
    await ctx.fiber.dispose();
    await tools.close();
    await state.close();
  });
  const agents = { key, emailKey, session, conversation };
  const principals: Record<keyof typeof agents, ApiPrincipal> = {
    key: keyPrincipal,
    emailKey: emailPrincipal,
    session: { kind: 'session', caller: session },
    conversation: { kind: 'conversation', caller: conversation },
  };
  return {
    state,
    scope,
    tools,
    alice,
    project,
    person,
    issued,
    emailed,
    agents,
    principals,
    login,
  };
}

/** One mounted handler called as the API would, with this principal. */
const route =
  (handler: MountHandler) =>
  async (principal: ApiPrincipal, method: string, path: string, body?: unknown) =>
    await handler(
      { method } as IncomingMessage,
      { setHeader() {} } as unknown as ServerResponse,
      {
        url: new URL(path, 'https://merv.example'),
        principal,
        json: async (schema?: z.ZodTypeAny) => (schema ? schema.parse(body) : body),
      } as ApiRequest,
    );

test('credentials stay the signed-in person’s: a key, an emailed-code key, a worker session and a Pi conversation are each refused at every credential handler and route', async (t) => {
  const f = await fixture(t);
  const agents = Object.entries(f.agents);
  const principals = Object.entries(f.principals);

  // Actor credentials, through the tools and directly on Scope, which refuses a conversation
  // itself rather than resting on the tools' 'never'.
  const made = (await f.tools.call('actor.create', f.person, {
    name: 'Robot',
    role: 'reader',
  })) as {
    actor: { id: string };
    credential: { id: string };
  };
  const target = { actorId: made.actor.id, credentialId: made.credential.id };
  const calls: [string, Record<string, unknown>][] = [
    ['actor.create', { name: 'Minted', role: 'reader' }],
    ['actor.credentials', { actorId: target.actorId }],
    ['actor.issue_token', { actorId: target.actorId }],
    ['actor.rotate_token', { credentialId: target.credentialId }],
    ['actor.revoke_token', { credentialId: target.credentialId }],
    ['actor.revoke', { actorId: target.actorId }],
  ];
  const head = await f.state.eventHead();
  for (const [kind, caller] of agents)
    for (const [name, input] of calls)
      await assert.rejects(
        f.tools.call(name, caller, input),
        (error: MervError) => error.status === 403,
        `${kind} ${name}`,
      );
  const credentials = f.scope.credentials;
  for (const [kind, caller] of agents)
    for (const attempt of [
      () => credentials.issueActor(caller, { name: 'Minted', role: 'reader' }),
      () => credentials.actorCredentials(caller, target.actorId),
      () => credentials.issueActorCredential(caller, { actorId: target.actorId }),
      () => credentials.rotateCredential(caller, { credentialId: target.credentialId }),
      () => credentials.revokeCredential(caller, target.credentialId),
      () => credentials.revokeActor(caller, target.actorId),
    ])
      await assert.rejects(attempt(), refused('forbidden', 403), kind);
  assert.equal(await f.state.eventHead(), head, 'nothing was minted, rotated or revoked');
  assert.equal(
    ((await f.tools.call('actor.credentials', f.person, { actorId: target.actorId })) as unknown[])
      .length,
    1,
    'the person still reads them',
  );

  // Her own user keys: an agent's caller has no account here, and a key is not her.
  const account = route(scopeRoutes(f.scope));
  const keyId = f.issued.key.id;
  const person: ApiPrincipal = { kind: 'user', user: f.alice.user, expiresAt: f.alice.expiresAt };
  const listed = (await account(person, 'GET', '/account/keys')) as { keys: [] };
  assert.equal(listed.keys.length, 2, 'her hand-made key and her agent’s');
  for (const [kind, principal] of principals)
    for (const [method, path, body] of [
      ['GET', '/account/keys'],
      ['POST', '/account/keys', { projectId: f.project.id }],
      ['POST', `/account/keys/${keyId}/rotate`, {}],
      ['DELETE', `/account/keys/${keyId}`],
      ['POST', `/account/keys/${f.emailed.key.id}/rotate`, {}],
    ] as const)
      await assert.rejects(
        account(principal, method, path, body),
        principal.kind === 'key' ? refused('forbidden', 403) : refused('not_found', 404),
        `${kind} ${method} ${path}`,
      );
  assert.deepEqual(
    await account(person, 'GET', '/account/keys'),
    listed,
    'none rotated or revoked',
  );

  // Her Hugging Face token.
  const status = { available: true, configured: true, updatedAt: null };
  const secrets = route(
    secretsRoutes({
      huggingFaceStatus: async () => status,
      saveHuggingFace: async () => status,
      removeHuggingFace: async () => status,
    } as unknown as Secrets),
  );
  assert.deepEqual(await secrets(person, 'GET', '/secrets/huggingface'), status);
  for (const [kind, principal] of principals)
    for (const [method, body] of [['GET'], ['PUT', { token: 'hf_x' }], ['DELETE']] as const)
      await assert.rejects(
        secrets(principal, method, '/secrets/huggingface', body),
        refused('forbidden', 403),
        `${kind} ${method}`,
      );

  // GitHub's OAuth connection: begin and finish are hers alone.
  const github = await createService(
    new CodeGitHubService(
      f.state,
      f.scope,
      {
        origin: 'http://127.0.0.1:4317',
        appSlug: 'merv-test',
        clientId: 'Iv1.synthetic',
        clientSecret: 'synthetic-client-secret',
        encryptionKey: 'bc'.repeat(32),
      },
      async () => {
        throw new Error('GitHub is never reached');
      },
    ),
  );
  t.after(() => github.close());
  assert.match((await github.begin(f.person, { expectedRevision: 0 })).url, /^https:/);
  await assert.rejects(github.finish(f.person, 'unknown'), (error: MervError) => {
    assert.notEqual(error.code, 'github_human_required');
    return true;
  });
  for (const [kind, caller] of agents) {
    const refusal = refused('github_human_required', 403);
    await assert.rejects(github.begin(caller, { expectedRevision: 0 }), refusal, kind);
    await assert.rejects(github.finish(caller, 'unknown'), refusal, kind);
  }

  // The Sandboxes console's sign-in code.
  const consoles = new MervService({
    scope: () => f.scope,
    accounts: { linked: async () => null },
    auth: { consoleCode: async () => 'code_once' },
    clock: { now: () => ({ plusSeconds: () => ({ toWire: () => '2030-01-01T00:00:00Z' }) }) },
    publicOrigin: 'https://sandboxes.example',
    refusals: mervRefusals(MervError),
  } as never);
  assert.match((await consoles.consoleSession(f.person)).url, /#code=code_once$/);
  for (const [kind, caller] of agents)
    await assert.rejects(
      consoles.consoleSession(caller),
      refused('sandbox_human_required', 403),
      kind,
    );

  // The platform's provider credentials: the configured admin alone, signed in.
  const ctx = new Context();
  ctx.provide('state', f.state);
  ctx.provide('scope', f.scope);
  const admin = await adminRoutes(ctx, [{ issuer, subject: 'alice' }]);
  t.after(() => ctx.fiber.dispose());
  // She passes the gate, to whatever this bare composition answers next.
  await assert.rejects(
    admin('POST', '/admin/credentials/reveal', { env: 'MERV_NOT_A_PLATFORM_SECRET' }),
    (error: MervError) => error.code !== 'forbidden',
  );
  for (const [kind, principal] of principals)
    for (const path of ['/admin/credentials/reveal', '/admin/credentials/change'])
      await assert.rejects(
        admin('POST', path, { env: 'MERV_NOT_A_PLATFORM_SECRET' }, principal as Principal),
        refused('forbidden', 403),
        `${kind} ${path}`,
      );

  // Any result carrying a bearer token never reaches a conversation, whatever the tool.
  t.after(
    f.tools.register({
      name: 'probe.leaky',
      description: 'Returns a token',
      readOnly: true,
      inputSchema: z.object({}).strict(),
      handler: () => ({ nested: [{ token: 'bearer' }] }),
    }),
  );
  await assert.rejects(
    f.tools.call('probe.leaky', f.agents.conversation, {}),
    refused('tool_result_secret', 403),
  );
});

test('an emailed-code key is issued only by consuming its challenge, once', async (t) => {
  const f = await fixture(t);
  // No handler, tool or route calls the issuer: only AgentLogins.verify does.
  const callers: string[] = [];
  const root = new URL('../packages/', import.meta.url);
  for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' }))
    if (
      /\/src\/.*\.ts$/.test(file) &&
      /issueForEmailLogin\(/.test(readFileSync(new URL(file, root), 'utf8'))
    )
      callers.push(file);
  assert.deepEqual(callers.sort(), ['scope/src/agent-logins.ts', 'scope/src/user-keys.ts']);

  const keys = () => f.state.read((sql) => sql.all<{ id: string }>('SELECT id FROM user_keys'));
  const before = await keys();
  const { started, verify } = await f.login();
  const wrong = started.code === '00000000' ? '00000001' : '00000000';
  await assert.rejects(verify(wrong), refused('invalid_code', 400));
  assert.deepEqual(await keys(), before, 'a wrong code issues nothing');
  // Two verifies race for one challenge: writers are serialized and verify rechecks it inside.
  const raced = await Promise.allSettled([verify(), verify()]);
  const won = raced.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  assert.equal(won.length, 1, 'exactly one verify consumed the challenge');
  for (const r of raced)
    if (r.status === 'rejected')
      assert.ok(refused('invalid_code', 400)(r.reason), String(r.reason));
  const after = await keys();
  assert.equal(after.length, before.length + 1);
  const row = await f.state.read((sql) =>
    sql.get<{ status: string; key_id: string }>(
      'SELECT status,key_id FROM agent_logins WHERE id=?',
      started.loginId,
    ),
  );
  assert.deepEqual(row, { status: 'used', key_id: won[0]!.key.id });
  await assert.rejects(verify(), refused('invalid_code', 400), 'a used challenge yields no key');
  assert.deepEqual(await keys(), after);
});

test('the ruling’s allowance: a person’s conversation is given signed upload and download links', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merv-credential-lock-'));
  const s3 = await s3Blobs(t);
  const app = await createApp({
    directory,
    config: {
      plugins: [
        { id: 'state', name: '@merv/state', config: stateConfig(directory) },
        { id: 'scope', name: '@merv/scope' },
        s3.entry,
        { id: 'artifacts', name: '@merv/artifacts' },
        { id: 'tools', name: '@merv/api/tools-plugin' },
        { id: 'artifact-tools', name: '@merv/artifacts/tools' },
      ],
    },
  });
  t.after(async () => {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const { scope, tools } = app.ctx;
  const alice = await scope.members.acceptVerifiedIdentity({
    issuer,
    subject: 'alice',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const project = await scope.members.createProject(alice, { name: 'Files', requestId: 'files' });
  const source = await scope.delegationSource(await scope.caller(alice, project.id));
  scope.registerConversationAuthority({ require: async () => source });
  t.after(tools.registerCallerRules('conversation', conversationRules));
  const conversation: Caller = {
    actorId: source.actorId,
    projectId: project.id,
    conversation: { id: 'conversation_files', epoch: 1, commandId: 'turn', runtimeId: 'runtime' },
  };
  const bytes = Buffer.from('id,value\n1,2\n');
  const plan = (await tools.call('artifact.upload_begin', conversation, {
    title: 'Rows.csv',
    size: bytes.length,
    sha256: sha256Hex(bytes),
    mediaType: 'text/csv',
  })) as ArtifactUploadStatus;
  assert.match(plan.parts[0]!.url, /^http/);
  assert.equal((await send(plan, bytes)).ok, true);
  const stored = (await tools.call('artifact.upload_complete', conversation, {
    uploadId: plan.uploadId,
  })) as { id: string };
  const { download } = (await tools.call('artifact.read', conversation, {
    artifactId: stored.id,
    mode: 'download',
  })) as { download: { url: string } };
  assert.deepEqual(Buffer.from(await (await fetch(download.url)).arrayBuffer()), bytes);
});
