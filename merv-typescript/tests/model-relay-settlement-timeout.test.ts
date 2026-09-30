import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { ModelRelay } from '../packages/fleet/src/model-relay.js';
import { deferred } from './fixtures/deferred.js';
import { deadline } from './fixtures/process-barrier.js';

for (const interruption of ['timeout', 'shutdown', 'disconnect'] as const) {
  test(
    `relay settlement: ${interruption} ends the HTTP wait without cancelling accounting`,
    { timeout: 5000 },
    async (t) => {
      const entered = deferred(),
        release = deferred(),
        lateCommit = deferred();
      const handled = deferred();
      let first = true,
        commits = 0;
      const grant = {
        id: 'same-lane',
        model: 'probe',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      const relay = new ModelRelay({
        name: 'probe',
        route: '/probe',
        token: /^probe$/,
        enabled: true,
        providerKey: () => 'synthetic-no-upstream',
        authority: {
          authorize: async () => grant,
          validate: async () => {},
        },
        grant: (value) => value as { id: string; model: string; expiresAt: string },
        lane: (grant) => grant.id,
        payload: () => ({ model: 'probe', stream: true }),
        maxRequestBytes: 1024,
        maxConcurrent: 1,
        totalTimeoutMs: interruption === 'timeout' ? 150 : 3000,
        reserve: async () => ({}),
        onUsage: async () => {
          const blocked = first;
          first = false;
          if (blocked) {
            entered.resolve();
            await release.promise;
          }
          commits++;
          if (blocked) lateCommit.resolve();
        },
        fetchImpl: async () =>
          new Response(
            'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      });
      const server = createServer((req, res) => {
        void relay.handle(req, res).then(() => handled.resolve());
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(async () => {
        release.resolve();
        relay.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/probe`;
      const controller = new AbortController();
      const call = (signal?: AbortSignal) =>
        fetch(url, {
          method: 'POST',
          headers: { authorization: 'Bearer probe', 'content-type': 'application/json' },
          body: '{}',
          signal,
        });
      // Observe client failure immediately so the disconnect case never leaves an unhandled rejection.
      const pending = call(controller.signal).then(
        (response) => ({ response }),
        (error: unknown) => ({ error }),
      );
      await deadline(entered.promise, 'settlement admission', 2000);
      if (interruption === 'shutdown') relay.close();
      if (interruption === 'disconnect') controller.abort();
      await deadline(handled.promise, 'HTTP handler interruption', 2000);
      assert.equal(commits, 0, 'Accounting stays pending after the handler releases its lane');
      const result = await deadline(pending, 'HTTP response', 2000);
      if (interruption === 'disconnect') assert.ok('error' in result);
      else {
        assert.ok('response' in result);
        assert.equal(result.response.status, interruption === 'timeout' ? 504 : 503);
        assert.doesNotMatch(await result.response.text(), /response.completed/);
      }
      if (interruption === 'timeout') {
        const next = await deadline(call(), 'successor admission', 2000);
        assert.equal(next.status, 200);
        assert.match(await next.text(), /response.completed/);
        assert.equal(commits, 1, 'A stuck earlier accounting write must not hold the HTTP lane');
      }
      release.resolve();
      await deadline(lateCommit.promise, 'late accounting commit', 2000);
      assert.equal(commits, interruption === 'timeout' ? 2 : 1);
    },
  );
}
