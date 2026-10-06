#!/usr/bin/env node
// Run inside Main's container after a release. Only a synthetic project and agent are created.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PostgresState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { CredentialStore, tokenDigest } from '@merv/identity/credentials';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;
const nonce = () => randomBytes(8).toString('hex');

export async function runCanary({ state, scope, origin }) {
  const credentials = new CredentialStore(state);
  let boot, source, helper, agentId;
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
  const expect = async (path, token, method, body, status) => {
    const response = await request(path, token, method, body);
    assert.equal(response.status, status, `${method} ${path}: HTTP ${response.status}`);
    return response.value;
  };
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
    const outsider = await request(
      '/sessions/agents',
      source.token,
      'GET',
      undefined,
      'project_identity_canary_other',
    );
    assert.equal(outsider.status, 403, `Wrong-project agent list: HTTP ${outsider.status}`);
    const original = secret();
    const registered = await expect(
      '/sessions/agents',
      source.token,
      'POST',
      {
        name: 'Identity canary agent',
        runnerId: 'external',
        requestId: label,
        secret: original,
      },
      200,
    );
    agentId = registered.agent.id;
    const self = await expect('/sessions/self', original, 'GET', undefined, 200);
    assert.equal(self.agent.id, agentId);
    const rotated = await expect(
      `/sessions/agents/${agentId}/rotate`,
      source.token,
      'POST',
      {},
      200,
    );
    assert.equal(rotated.agent.id, agentId);
    assert.notEqual(rotated.token, original);
    await expect('/sessions/self', original, 'GET', undefined, 401);
    const next = await expect('/sessions/self', rotated.token, 'GET', undefined, 200);
    assert.equal(next.agent.id, agentId);
    await expect(`/sessions/agents/${agentId}`, source.token, 'DELETE', undefined, 200);
    retired = true;
    await expect('/sessions/self', rotated.token, 'GET', undefined, 401);
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
      agentId,
      registration: 200,
      wrongProject: 403,
      oldAfterRotation: 401,
      rotatedSelf: 200,
      retiredSelf: 401,
      identityMigrationHash: migration.hash,
    };
  } finally {
    // Retire before revoking its source. No assignment or machine is ever requested.
    let cleanupError;
    if (agentId && !retired && source) {
      try {
        const response = await request(`/sessions/agents/${agentId}`, source.token, 'DELETE');
        if (response.status !== 200)
          cleanupError = new Error(`Canary agent cleanup failed: HTTP ${response.status}`);
      } catch {
        cleanupError = new Error('Canary agent cleanup failed');
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
        const denied = await request('/sessions/agents', source.token);
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
