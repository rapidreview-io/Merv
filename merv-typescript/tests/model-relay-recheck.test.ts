import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createService } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import type { ManagedModelGrant } from '@merv/fleet/types';
import { ModelRelay } from '../packages/fleet/src/model-relay.js';
import { codexModelRelay } from '../packages/fleet/src/codex-relay.js';
import { modelMigrations } from '../packages/fleet/src/schema.js';
import { openState } from './fixtures/state.js';

const bearer = `ms_${'b'.repeat(43)}`;
const grant: ManagedModelGrant = {
  id: 'session_recheck',
  projectId: 'project_recheck',
  allocationId: 'flt_recheck',
  person: 'person_recheck',
  model: 'gpt-6-luna',
  effort: 'medium',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

// A streaming call re-reads its grant (some ten queries in production) while it streams. Frames
// may rest on a read up to 5 s old, so it reads about every 3 s, not every second.
test('a streaming call re-reads its grant about every 3 s', { timeout: 30_000 }, async (t) => {
  const state = await openState();
  await createService(new ProjectScope(state));
  await state.migrate('fleet_workflow', modelMigrations);
  const reads: number[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const relay = new ModelRelay(
    codexModelRelay(state, {
      providerKey: () => 'provider-key',
      dailyTokensPerPerson: 1_000_000,
      authorize: async () => {
        reads.push(Date.now());
        return grant;
      },
    }),
    {
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode('event: response.created\ndata: {}\n\n'));
              await held;
              controller.enqueue(
                encoder.encode(
                  `event: response.completed\ndata: ${JSON.stringify({
                    type: 'response.completed',
                    response: { usage: { input_tokens: 5, output_tokens: 5 } },
                  })}\n\n`,
                ),
              );
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    },
  );
  const server = createServer((req, res) => void relay.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    relay.close();
    server.close();
  });
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/codex-model/responses`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-6-luna',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        store: false,
        stream: true,
      }),
    },
  );
  assert.equal(response.status, 200);
  const streaming = Date.now();
  const before = reads.length;
  await new Promise((resolve) => setTimeout(resolve, 3_600));
  release();
  assert.match(await response.text(), /response\.completed/);
  const rereads = reads.slice(before).filter((at) => at - streaming < 3_600);
  assert.equal(rereads.length, 1, `re-read ${rereads.length} times in 3.6 s`);
});
