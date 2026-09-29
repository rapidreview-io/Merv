import { createService } from '@merv/contracts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Caller } from '@merv/contracts';

import { ProjectScope } from '@merv/scope';
import { ToolRegistry } from '@merv/api';
import { Bindings } from '../packages/mounts/src/credentials.js';
import { Invocations } from '../packages/mounts/src/upstream.js';
import { openState } from './fixtures/state.js';
import { deferred } from './fixtures/deferred.js';

for (const withdrawal of ['key-revocation', 'membership-rejoin'] as const) {
  test(
    `mounted dispatch retains the user-key fence across connection setup and ${withdrawal}`,
    { timeout: 5000 },
    async (t) => {
      const state = await openState(':memory:');
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
      const bindings = new Bindings(scope, [
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
      // Calls go through the registry, which admits each one as in production.
      const registry = new ToolRegistry(scope, access);
      const pool = new Invocations(
        { id: 'bridge', url: 'https://unused-mount.example/mcp', timeoutMs: 1500 },
        bindings,
        access,
        registry,
        {
          connect: async () => {
            const connection = { closes: 0 };
            connections.push(connection);
            // Only the SDK I/O is substituted. All caller, grant, and credential checks are real.
            if (connections.length === 1) {
              entered.resolve();
              await release.promise;
            }
            return {
              request: async (request: unknown) => {
                dispatched.push(request);
                return { content: [], structuredContent: { dispatched: true } };
              },
              close: async () => {
                connection.closes++;
              },
            } as unknown as Client;
          },
        },
      );
      await registry.createCatalog('bridge').replace([
        {
          kind: 'mcp',
          name: 'inspect',
          inputSchema: { type: 'object' },
          handler: pool.handler('inspect'),
        },
      ]);
      const call = (caller: Caller, marker: string) =>
        registry.call('_bridge.inspect', caller, { marker });
      t.after(async () => {
        release.resolve();
        try {
          await registry.close();
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
      const binding = await bindings.select(captured, 'bridge');
      assert.equal((await bindings.headers(binding)).authorization, `Bearer ${upstreamToken}`);
      const pending = call(captured, 'stale');
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
      // A refusal concerns the call: the connection stays for the actor's current callers.
      assert.equal(connections[0].closes, 0, 'A refused call keeps its connection');

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
      assert.equal(await bindings.select(currentKey, 'bridge'), binding);
      assert.equal(await bindings.select(currentHuman, 'bridge'), binding);

      // Keep the same explicit grant and binding: withdrawing one caller must not kill the actor.
      await call(currentKey, 'independent-key');
      await call(currentHuman, 'human-owner');
      assert.deepEqual(dispatched, [
        {
          method: 'tools/call',
          params: { name: 'inspect', arguments: { marker: 'independent-key' } },
        },
        { method: 'tools/call', params: { name: 'inspect', arguments: { marker: 'human-owner' } } },
      ]);
      assert.equal(connections.length, 1, 'Current callers of the actor reuse its connection');
      // The registry refuses the stale caller before the warm connection is reached.
      await assert.rejects(call(captured, 'still-stale'), {
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
