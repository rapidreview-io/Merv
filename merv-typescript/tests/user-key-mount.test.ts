import { createService } from '@merv/contracts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { EnvironmentCredentials } from '../packages/mounts/src/credentials.js';
import { ScopedRemoteClients } from '../packages/mounts/src/credential-client.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const withdrawal of ['key-revocation', 'membership-rejoin'] as const) {
  test(
    `mounted dispatch retains the user-key fence across connection setup and ${withdrawal}`,
    { timeout: 5000 },
    async (t) => {
      const state = new SqliteState(':memory:');
      const scope = await createService(new ProjectScope(state));
      const verified = async (subject: string) =>
        await scope.acceptVerifiedIdentity({
          issuer: 'https://mount-identity.example/auth/v1',
          subject,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      const operator = await verified('operator');
      const owner = await verified('worker');
      const project = await scope.createProject(operator, {
        name: 'Key mount fence',
        requestId: 'project',
      });
      await scope.addMember(operator, project.id, { subject: 'worker', role: 'producer' });
      const original = await scope.createKey(owner, { projectId: project.id });
      const independent = await scope.createKey(owner, { projectId: project.id });
      const captured = await scope.caller({
        kind: 'key',
        key: await scope.authenticateKey(original.token),
      });
      const ownerActorId = captured.actorId;
      const envName = `MERV_KEY_MOUNT_${randomUUID().replaceAll('-', '_')}`;
      const upstreamToken = 'synthetic-explicit-upstream-credential';
      process.env[envName] = upstreamToken;
      const access = scope.toolPolicy;
      access.replace([
        {
          projectId: project.id,
          actorId: ownerActorId,
          mountId: 'bridge',
          tools: ['inspect'],
        },
      ]);
      const credentials = new EnvironmentCredentials(scope, [
        {
          id: 'explicit-worker-binding',
          projectId: project.id,
          actorId: ownerActorId,
          mountId: 'bridge',
          secretRef: `env:${envName}`,
        },
      ]);
      const entered = deferred();
      const release = deferred();
      const connections: { closes: number }[] = [];
      const dispatched: unknown[] = [];
      const pool = new ScopedRemoteClients(credentials, access, {
        mounts: { bridge: { url: 'https://unused-mount.example/mcp' } },
        timeoutMs: 1500,
        clientFactory: () => {
          const connection = { closes: 0 };
          connections.push(connection);
          const held = connections.length === 1;
          // Only the SDK I/O is substituted. All caller, grant, and credential checks are real.
          return {
            connect: async () => {
              if (held) {
                entered.resolve();
                await release.promise;
              }
            },
            request: async (request: unknown) => {
              dispatched.push(request);
              return { content: [], structuredContent: { dispatched: true } };
            },
            close: async () => {
              connection.closes++;
            },
          } as unknown as Client;
        },
      });
      t.after(async () => {
        release.resolve();
        try {
          await pool.close();
        } finally {
          await state.close();
          delete process.env[envName];
        }
      });
      t.mock.method(globalThis, 'fetch', async () => {
        assert.fail('The mount fixture must never make a network request');
      });

      assert.equal(await access.allows(captured, 'bridge', 'inspect'), true);
      assert.equal(
        (await credentials.resolve(captured, 'bridge')).headers().authorization,
        `Bearer ${upstreamToken}`,
      );
      const pending = pool.call(captured, 'bridge', 'inspect', { marker: 'stale' });
      const denied = assert.rejects(pending, {
        code: withdrawal === 'key-revocation' ? 'forbidden' : 'membership_required',
      });
      await entered.promise;
      assert.equal(dispatched.length, 0);
      if (withdrawal === 'key-revocation') {
        await scope.revokeKey(owner, original.key.id);
      } else {
        await scope.removeMember(operator, project.id, 'worker');
        await scope.addMember(operator, project.id, { subject: 'worker', role: 'producer' });
        // The bearer is still active: only its captured membership generation is stale.
        assert.equal((await scope.authenticateKey(original.token)).id, original.key.id);
      }
      release.resolve();
      await denied;
      assert.equal(dispatched.length, 0, 'Withdrawn authority never crosses the upstream boundary');
      assert.equal(connections[0].closes, 1, 'The rejected connection is cleaned up');

      const currentKey = await scope.caller({
        kind: 'key',
        key: await scope.authenticateKey(independent.token),
      });
      const currentHuman = await scope.caller(owner, project.id);
      assert.equal(currentKey.actorId, ownerActorId);
      assert.equal(currentHuman.actorId, ownerActorId);
      assert.equal(currentKey.key!.membershipId, currentHuman.human!.membershipId);
      if (withdrawal === 'membership-rejoin')
        assert.notEqual(currentKey.key!.membershipId, captured.key!.membershipId);
      assert.equal((await scope.require(currentHuman, 'write')).role, 'producer');
      assert.equal(
        (await credentials.resolve(currentKey, 'bridge')).identityKey,
        (await credentials.resolve(currentHuman, 'bridge')).identityKey,
      );

      // Keep the same explicit grant and binding: withdrawing one caller must not kill the actor.
      await pool.call(currentKey, 'bridge', 'inspect', { marker: 'independent-key' });
      await pool.call(currentHuman, 'bridge', 'inspect', { marker: 'human-owner' });
      assert.deepEqual(dispatched, [
        {
          method: 'tools/call',
          params: { name: 'inspect', arguments: { marker: 'independent-key' } },
        },
        { method: 'tools/call', params: { name: 'inspect', arguments: { marker: 'human-owner' } } },
      ]);
      assert.equal(
        connections.length,
        2,
        'Current callers can reuse their matching upstream identity',
      );
      await assert.rejects(pool.call(captured, 'bridge', 'inspect', { marker: 'still-stale' }), {
        code: withdrawal === 'key-revocation' ? 'forbidden' : 'membership_required',
      });
      assert.equal(
        dispatched.length,
        2,
        'A cached connection cannot bypass the original caller fence',
      );
    },
  );
}
