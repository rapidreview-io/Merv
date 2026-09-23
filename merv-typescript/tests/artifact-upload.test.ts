import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { artifactFile, uploadArtifact } from '../src/artifact-upload.js';
import { createApp } from './fixtures/app.js';

test('file convenience bounds and encodes local text/binary without server filesystem access', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merv-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'result.md');
  writeFileSync(file, 'Evidence π');
  const payload = artifactFile(file);
  assert.equal(Buffer.from(payload.content, 'base64').toString(), 'Evidence π');
  assert.equal(payload.mediaType, 'text/markdown');
  assert.equal(payload.title, 'result.md');
  assert.throws(() => artifactFile(dir), { code: 'artifact_file' });
  writeFileSync(file, Buffer.alloc(2_000_001));
  assert.throws(() => artifactFile(file), { code: 'artifact_file' });
  writeFileSync(file, '');
  assert.throws(() => artifactFile(file), { code: 'artifact_file' });
});

test('file upload uses normal MCP session authority and returns a verified small receipt', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merv-file-mcp-'));
  const app = await createApp({ directory: join(dir, 'state'), api: true, port: 0 });
  t.after(async () => {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Upload', actorName: 'Owner' });
  const owner = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const task = await app.ctx.tasks.create(owner, {
    title: 'File proof',
    goal: 'Retain generated evidence.',
    checks: ['Evidence retained.'],
    requestId: 'task',
  });
  const token = `ms_${randomBytes(32).toString('base64url')}`;
  const agent = await app.ctx.sessions.registerAgent(owner, {
    name: 'File producer',
    runnerId: 'file-test',
    requestId: 'agent',
    secret: token,
  });
  const execution = await app.ctx.sessions.assignAgent(token, {
    instanceId: task.id,
    expectedRevision: 0,
    requestId: 'work',
  });
  const file = join(dir, 'proof.txt');
  const content = 'Retained result.\n'.repeat(2000);
  writeFileSync(file, content);
  const receipt = await uploadArtifact({ url: app.ctx.api.url!, file, token });
  assert.equal(receipt.createdBy, agent.actorId);
  assert.equal((await app.ctx.artifacts.read(owner, receipt.id)).content, content);
  assert.ok(JSON.stringify(receipt).length < 1000);
  assert.equal('content' in receipt, false);
  assert.equal(
    (await app.ctx.sessions.agentObservation(owner, agent.id)).toolCalls[0]!.tool,
    'artifact.create',
  );
  await app.ctx.sessions.releaseAgentAssignment(token, execution.id);
  await assert.rejects(uploadArtifact({ url: app.ctx.api.url!, file, token }), {
    code: 'artifact_upload_failed',
  });
  const reader = await app.ctx.scope.issueActor(owner, { name: 'Reader', role: 'reader' });
  await assert.rejects(uploadArtifact({ url: app.ctx.api.url!, file, token: reader.token }), {
    code: 'artifact_upload_failed',
  });
  await assert.rejects(uploadArtifact({ url: 'http://example.com', file, token }), {
    code: 'artifact_url',
  });
});
