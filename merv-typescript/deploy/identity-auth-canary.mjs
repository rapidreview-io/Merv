#!/usr/bin/env node
// Run inside Main's container after a release. Only a synthetic project and its actors are
// created; every one is revoked before the canary returns.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PostgresState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { CredentialStore, tokenDigest } from '@merv/identity/credentials';

const nonce = () => randomBytes(8).toString('hex');

export async function runCanary({ state, scope, origin }) {
  const credentials = new CredentialStore(state);
  let boot, source, helper, agentActorId;
  let retired = false;
  const request = async (path, token, method = 'GET', body, projectId = source?.projectId) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(projectId ? { 'x-merv-project-id': projectId } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json().catch(() => ({}));
    return { status: response.status, value };
  };
  /** One tool call over HTTP, as Merv's own pages make it. */
  const tool = async (name, token, input, status, projectId) => {
    const response = await request(`/tools/${name}`, token, 'POST', input, projectId);
    assert.equal(response.status, status, `${name}: HTTP ${response.status}`);
    return response.value.result;
  };
  const whoami = (token, status, projectId) => tool('actor.whoami', token, {}, status, projectId);
  try {
    const label = nonce();
    boot = await scope.credentials.bootstrap({
      projectName: `Identity canary ${label}`,
      actorName: 'Canary source',
    });
    const first = {
      actorId: boot.actor.id,
      projectId: boot.project.id,
      credentialId: boot.credential.id,
    };
    // One deadline for everything the canary mints: nothing minted through an expiring actor
    // credential may outlive it.
    const deadline = new Date(Date.now() + 15 * 60_000).toISOString();
    const issued = await scope.credentials.issueActorCredential(first, {
      actorId: first.actorId,
      expiresAt: deadline,
    });
    source = {
      token: issued.token,
      projectId: first.projectId,
      actorId: first.actorId,
      credentialId: issued.credential.id,
    };
    await scope.credentials.revokeCredential(source, boot.credential.id);
    helper = await scope.credentials.issueActor(source, {
      name: 'Canary cleanup',
      role: 'operator',
      expiresAt: deadline,
    });
    // Registration: the source creates an agent's actor and its first project-bound credential.
    const registered = await tool(
      'actor.create',
      source.token,
      { name: 'Identity canary agent', role: 'reader' },
      200,
    );
    agentActorId = registered.actor.id;
    const original = registered.token;
    assert.equal((await whoami(original, 200)).id, agentActorId);
    // The credential is bound to its project: naming another is refused.
    await whoami(original, 403, 'project_identity_canary_other');
    const rotated = await tool(
      'actor.rotate_token',
      source.token,
      { credentialId: registered.credential.id },
      200,
    );
    assert.equal(rotated.actor.id, agentActorId);
    assert.notEqual(rotated.token, original);
    await whoami(original, 401);
    assert.equal((await whoami(rotated.token, 200)).id, agentActorId);
    await tool('actor.revoke', source.token, { actorId: agentActorId }, 200);
    retired = true;
    await whoami(rotated.token, 401);
    const migration = await state.read((sql) =>
      sql.get(
        'SELECT hash FROM component_migrations WHERE component=? AND version=?',
        'identity-credentials',
        1,
      ),
    );
    assert.match(migration?.hash ?? '', /^[0-9a-f]{64}$/);
    return {
      result: 'pass',
      projectId: source.projectId,
      actorId: agentActorId,
      registration: 200,
      wrongProject: 403,
      oldAfterRotation: 401,
      rotatedSelf: 200,
      retiredSelf: 401,
      identityMigrationHash: migration.hash,
    };
  } finally {
    // Retire the agent's actor before revoking its source.
    let cleanupError;
    if (agentActorId && !retired && source) {
      try {
        const response = await request('/tools/actor.revoke', source.token, 'POST', {
          actorId: agentActorId,
        });
        if (response.status !== 200)
          cleanupError = new Error(`Canary actor cleanup failed: HTTP ${response.status}`);
      } catch {
        cleanupError = new Error('Canary actor cleanup failed');
      }
    }
    try {
      if (helper && source) {
        await scope.credentials.revokeCredential(source, helper.credential.id);
        const trusted = { actorId: helper.actor.id, projectId: source.projectId };
        await scope.credentials.revokeCredential(trusted, source.credentialId);
        await scope.credentials.revokeActor(trusted, source.actorId);
      }
    } catch {
      cleanupError ??= new Error('Canary Scope cleanup failed');
    }
    try {
      if (source) await credentials.revoke(tokenDigest(source.token), 'scope');
      if (boot) await credentials.revoke(tokenDigest(boot.token), 'scope');
      if (helper) await credentials.revoke(tokenDigest(helper.token), 'scope');
      if (source) {
        const denied = await request('/tools/actor.whoami', source.token, 'POST', {});
        if (denied.status !== 401)
          cleanupError ??= new Error(`Canary source remained usable: HTTP ${denied.status}`);
      }
      if (source && helper) {
        const rows = await state.read(async (sql) => ({
          source: await sql.get(
            'SELECT a.active,c.revoked_at FROM actors a JOIN actor_credentials c ON c.actor_id=a.id WHERE c.id=?',
            source.credentialId,
          ),
          helper: await sql.get(
            'SELECT revoked_at FROM actor_credentials WHERE id=?',
            helper.credential.id,
          ),
        }));
        if (rows.source?.active || !rows.source?.revoked_at || !rows.helper?.revoked_at)
          cleanupError ??= new Error('Canary legacy credential cleanup was incomplete');
      }
    } catch {
      cleanupError ??= new Error('Canary credential cleanup failed');
    }
    if (cleanupError) throw cleanupError;
  }
}

if (process.env.MERV_IDENTITY_CANARY === '1') {
  const url = process.env.MERV_DB_URL;
  const schema = process.env.MERV_TS_DB_SCHEMA;
  assert.ok(url && schema, 'Run only inside the configured Main container');
  const state = await PostgresState.open({
    connectionString: url,
    schema,
    maxConnections: 2,
    readConnections: 2,
  });
  try {
    const scope = new ProjectScope(state);
    await scope.initialize();
    console.log(JSON.stringify(await runCanary({ state, scope, origin: 'http://127.0.0.1:3081' })));
  } finally {
    await state.close();
  }
}
