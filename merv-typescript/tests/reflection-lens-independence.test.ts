/**
 * While a wave reflects, a lens's agent reads no other lens's report: not through reflection.get
 * or reflection.lens, nor through artifact.list or artifact.read, and not on an inquiry visit to
 * its thread, which holds no lease.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Caller } from '@merv/contracts';
import type { Session } from '../packages/sessions/src/types.js';
import type { ApplicationConfig } from '../src/config.js';
import { createApp } from './fixtures/app.js';
import { s3Blobs } from './fixtures/s3-blobs.js';
import { waitForManagedCode } from './fixtures/managed-code.js';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;

test('a lens agent reads no other lens report mid-wave, on a work or an inquiry visit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merv-lens-independence-'));
  const env = `MERV_LENS_${randomUUID().replaceAll('-', '')}`;
  process.env[env] = randomBytes(48).toString('hex');
  const s3 = await s3Blobs(t);
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  config.plugins = config.plugins.map((plugin) =>
    plugin.id === 'sessions'
      ? { ...plugin, config: { managedSecretEnv: env, sweepIntervalMs: 60_000 } }
      : plugin.id === 'blobs'
        ? s3.entry
        : plugin,
  );
  const app = await createApp({ directory, config, port: 0 });
  t.after(async () => {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
    delete process.env[env];
  });
  const scope = app.ctx.scope;
  const boot = await scope.credentials.bootstrap({
    projectName: 'Lens inquiry',
    actorName: 'Owner',
  });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const token = boot.token;
  await waitForManagedCode(app.ctx.codeWork, owner);
  const http = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${app.ctx.api.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, `${path}: ${text}`);
    return JSON.parse(text);
  };

  const wave = await app.ctx.reflections.create(owner, { requestId: 'wave' });
  const [lensA, lensB] = wave.lenses;
  // Lens B is written by another author; the wave still reflects (three lenses open).
  const issued = await scope.credentials.issueActor(owner, { name: 'Author B', role: 'producer' });
  const authorB: Caller = {
    actorId: issued.actor.id,
    projectId: owner.projectId,
    credentialId: issued.credential.id,
  };
  const report = await app.ctx.artifacts.create(authorB, {
    title: 'Lens B',
    content: '# Summary\nLENS-B-SECRET finding.',
    mediaType: 'text/markdown',
  });
  await app.ctx.reflections.submitLens(authorB, {
    lensId: lensB!.id,
    expectedRevision: lensB!.workflow.revision,
    artifactId: report.id,
    requestId: 'lens-b',
  });
  assert.equal((await app.ctx.reflections.get(owner, wave.id)).workflow.state, 'reflecting');

  // Lens A's agent works a visit, keeps its conversation, and its visit ends (dormant thread).
  const { revision } = await app.ctx.workflows.get(owner, lensA!.id);
  const workSecret = secret();
  const session = (await app.ctx.sessions.offer(owner, {
    instanceId: lensA!.id,
    expectedRevision: revision,
    runnerId: 'runner-a',
    requestId: randomUUID(),
    secret: workSecret,
  })) as Session;
  const control = { runnerId: 'runner-a', hostRef: `launch-${randomUUID()}` };
  await http('POST', `/sessions/${session.id}/attach`, control);
  const lensWorker = await app.ctx.sessions.authenticate(workSecret);
  const asWork = (
    await app.ctx.tools.invoke('reflection.get', lensWorker, { reflectionId: wave.id })
  ).value as any;
  const seenByWork = asWork.lenses.find((lens: any) => lens.id === lensB!.id).artifact;
  const reads = async (caller: Caller) => ({
    read: await app.ctx.tools.invoke('artifact.read', caller, { artifactId: report.id }).then(
      (r: any) => JSON.stringify(r.value).includes('LENS-B-SECRET'),
      (e: any) => `refused ${e.code}`,
    ),
    get: await app.ctx.tools.invoke('artifact.get', caller, { artifactId: report.id }).then(
      () => 'found',
      (e: any) => `refused ${e.code}`,
    ),
    listed: await app.ctx.tools
      .invoke('artifact.list', caller, {})
      .then((r: any) => JSON.stringify(r.value).includes(report.id)),
  });
  const withheld = { read: 'refused not_found', get: 'refused not_found', listed: false };
  assert.deepEqual(
    await reads(lensWorker),
    withheld,
    'a lens work visit reads no other lens report',
  );
  assert.equal(
    (
      (await app.ctx.tools.invoke('reflection.lens', lensWorker, { lensId: lensB!.id }))
        .value as any
    ).artifact,
    null,
  );
  // Its own work, and anyone outside the lens, still read everything.
  const own = await app.ctx.tools.invoke('artifact.create', lensWorker, {
    title: 'Lens A notes',
    content: 'A',
  });
  assert.ok(
    JSON.stringify((await app.ctx.tools.invoke('artifact.list', lensWorker, {})).value).includes(
      (own.value as any).id,
    ),
  );
  assert.equal(
    (await app.ctx.artifacts.read(owner, report.id)).content.includes('LENS-B-SECRET'),
    true,
  );
  await http('POST', `/sessions/${session.id}/release`, { runnerId: 'runner-a' });
  const bytes = Buffer.from(`{"type":"user","text":"${randomUUID()}"}\n`);
  const facts = {
    harness: 'claude',
    conversationId: '0199a0b2-1111-7222-8333-944445555666',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
  const path = `/sessions/${session.id}/conversation`;
  await http('POST', path, { ...control, ...facts });
  const { upload } = (await http('POST', path, { ...control, ...facts, deliver: true }))
    .conversation;
  assert.equal(
    (
      await fetch(upload.url, {
        method: 'PUT',
        headers: upload.headers,
        body: new Uint8Array(bytes),
      })
    ).status,
    200,
  );
  await http('POST', path, { ...control, ...facts, deliver: true });

  // A person asks lens A's agent a question while the wave still reflects.
  await app.ctx.sessions.dispatch.setDispatch(owner, { enabled: true });
  const asked = (
    await http('POST', `/sessions/threads/${session.threadId}/ask`, {
      body: 'What did you find so far?',
      requestId: 'ask',
    })
  ).inquiry;
  await http('POST', '/sessions/runners/heartbeat', {
    runnerId: 'runner-q',
    capabilities: ['inquiry.1', 'runner.2'],
    machine: { hostname: 'Test host', system: 'Darwin', architecture: 'arm64' },
    platforms: [{ name: 'claude', harness: 'claude', enabled: true, parallelism: 8 }],
    capacity: 8,
  });
  // The visit as the lease route sends it: an inquiry visit names its question.
  let inquiry: { session: Session & { inquiry?: { id: string } }; secret: string } | undefined;
  for (let i = 0; i < 8 && !inquiry; i++) {
    const s = secret();
    const leased = await http('POST', '/sessions/lease', {
      runnerId: 'runner-q',
      requestId: randomUUID(),
      secret: s,
      platform: { name: 'claude', harness: 'claude' },
    });
    if (!leased.session) break;
    if (leased.session.inquiry) inquiry = { session: leased.session, secret: s };
  }
  assert.ok(inquiry, 'the inquiry visit is leased');
  assert.equal(inquiry.session.inquiry?.id, asked.id);
  const inquirer = await app.ctx.sessions.authenticate(inquiry.secret);
  const asInquiry = (
    await app.ctx.tools.invoke('reflection.get', inquirer, { reflectionId: wave.id })
  ).value as any;
  const seenByInquiry = asInquiry.lenses.find((lens: any) => lens.id === lensB!.id).artifact;
  assert.equal(seenByWork, null, 'a lens work visit is withheld the other lenses');
  assert.equal(seenByInquiry, null, 'an inquiry visit of that lens is withheld them too');
  assert.deepEqual(await reads(inquirer), withheld, 'an inquiry visit reads no other lens report');
});
