import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { runPiWorker } from '../packages/pi/src/worker.js';
import { PiModelRelay } from '../packages/pi/src/relay.js';
import { piResponsesSchema, validPiPayload } from '../packages/pi/src/relay-schema.js';
import type { PiBootstrap, PiCompletion, PiWork } from '../packages/pi/src/types.js';

const workerToken = `piw_flt_fixture.${'a'.repeat(43)}`;
const modelToken = `pir_${'b'.repeat(43)}`;
const expiresAt = () => new Date(Date.now() + 20_000).toISOString();

function mockResponse(text: string, deltas = [text]): Response {
  const item = {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
  const body =
    frame({ type: 'response.created', response: { id: 'resp_fixture' } }) +
    frame({ type: 'response.output_item.added', output_index: 0, item }) +
    deltas
      .map((delta) =>
        frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta }),
      )
      .join('') +
    frame({ type: 'response.output_item.done', output_index: 0, item }) +
    frame({
      type: 'response.completed',
      response: {
        id: 'resp_fixture',
        status: 'completed',
        output: [item],
        usage: { input_tokens: 12, output_tokens: 8 },
      },
    });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function mockToolResponse(): Response {
  const item = {
    id: 'fc_fixture',
    type: 'function_call',
    name: 'project_get',
    call_id: 'call_fixture',
    arguments: '{}',
    status: 'completed',
  };
  const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
  const body =
    frame({ type: 'response.created', response: { id: 'resp_fixture' } }) +
    frame({
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, arguments: '', status: 'in_progress' },
    }) +
    frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' }) +
    frame({ type: 'response.function_call_arguments.done', output_index: 0, arguments: '{}' }) +
    frame({ type: 'response.output_item.done', output_index: 0, item }) +
    frame({
      type: 'response.completed',
      response: {
        id: 'resp_fixture',
        status: 'completed',
        output: [item],
        usage: { input_tokens: 12, output_tokens: 8 },
      },
    });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function mockReasoningToolResponse(): Response {
  const reasoning = {
    id: 'rs_fixture',
    type: 'reasoning',
    content: [],
    encrypted_content: 'synthetic-reasoning-signature',
    summary: [],
  };
  const call = {
    id: 'fc_fixture_2',
    type: 'function_call',
    name: 'project_get',
    call_id: 'call_fixture_2',
    arguments: '{}',
    status: 'completed',
  };
  const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
  return new Response(
    frame({ type: 'response.created', response: { id: 'resp_reasoning' } }) +
      frame({ type: 'response.output_item.added', output_index: 0, item: reasoning }) +
      frame({ type: 'response.output_item.done', output_index: 0, item: reasoning }) +
      frame({ type: 'response.output_item.added', output_index: 1, item: call }) +
      frame({ type: 'response.output_item.done', output_index: 1, item: call }) +
      frame({
        type: 'response.completed',
        response: {
          id: 'resp_reasoning',
          status: 'completed',
          output: [reasoning, call],
          usage: { input_tokens: 12, output_tokens: 8 },
        },
      }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

for (const upstreamStatus of [
  200,
  400,
  'tool',
  'reasoning',
  'burst',
  'revoked',
  'cancelled',
  'long',
] as const)
  test(`pinned SDK worker and local Pi relay handle mock upstream ${upstreamStatus}`, async (context) => {
    const controller = new AbortController();
    const forwarded: Array<Record<string, unknown>> = [];
    const failures: string[] = [];
    const completions: PiCompletion[] = [];
    const progress: Array<{ type: string; text: string }> = [];
    // The first delta puts an emoji across the 8192-unit event boundary.
    const burstDeltas = [
      `${'x'.repeat(8191)}\u{1F600}`,
      ...Array.from({ length: 160 }, (_, index) => `[${index}]`),
    ];
    const burstText = burstDeltas.join('');
    // Far past the old 4096-token cap, 128,000-character message, 64-event buffer and 256 KiB
    // relay frame; the next turn carries it as history.
    const longDeltas = Array.from({ length: 80 }, (_, index) => `${index}`.padEnd(8192, 'x'));
    const grantExpiresAt = expiresAt();
    let toolInvocations = 0;
    const relay = new PiModelRelay({
      enabled: true,
      models: [{ id: 'gpt-6-luna', effort: 'none' }],
      providerKey: () => 'synthetic-provider-key',
      authority: {
        authorize: async (token) => {
          assert.equal(token, modelToken);
          return {
            id: 'fixture-grant',
            userId: 'fixture-user',
            projectId: 'fixture-project',
            conversationId: 'pic_fixture',
            commandId: 'cmd_fixture',
            runtimeId: 'flt_fixture',
            epoch: 1,
            expiresAt: grantExpiresAt,
            model: 'gpt-6-luna',
            toolNames: ['project_get'],
          };
        },
        validate: async () => {},
      },
      fetchImpl: async (input, init) => {
        assert.equal(String(input), 'https://api.openai.com/v1/responses');
        forwarded.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (upstreamStatus === 'reasoning')
          return forwarded.length === 1
            ? mockToolResponse()
            : forwarded.length === 2
              ? mockReasoningToolResponse()
              : mockResponse('Offline fixture complete');
        if (upstreamStatus === 'tool')
          return forwarded.length === 1
            ? mockToolResponse()
            : mockResponse('Offline fixture complete');
        return upstreamStatus !== 400
          ? upstreamStatus === 'burst'
            ? mockResponse(burstText, burstDeltas)
            : upstreamStatus === 'long' && forwarded.length === 1
              ? mockResponse(longDeltas.join(''), longDeltas)
              : mockResponse('Offline fixture complete')
          : new Response(JSON.stringify({ error: { code: 'synthetic-rejection' } }), {
              status: upstreamStatus,
              headers: { 'content-type': 'application/json' },
            });
      },
    });
    const server = createServer((request, response) => {
      void relay.handle(request, response);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}/`;
    context.after(() => {
      controller.abort();
      relay.close();
      server.closeAllConnections();
      server.close();
    });
    const bootstrap: PiBootstrap = {
      kind: 'pi',
      version: 2,
      baseUrl,
      hostId: 'pih_fixture',
      runtimeId: 'flt_fixture',
      epoch: 1,
      machine: 'standard',
      slots: 3,
      workerToken,
      expiresAt: expiresAt(),
    };
    const work: PiWork = {
      command: {
        id: 'cmd_fixture',
        conversationId: 'pic_fixture',
        hostId: 'pih_fixture',
        machine: 'standard',
        runtimeId: 'flt_fixture',
        epoch: 1,
        status: 'starting',
        messages: [{ role: 'user', text: 'Return a short greeting.' }],
        outcomes: [],
        error: null,
        createdAt: expiresAt(),
        expiresAt: expiresAt(),
        completedAt: null,
      },
      checkpoint: null,
      model: 'gpt-6-luna',
      modelBaseUrl: `${baseUrl.slice(0, -1)}/pi-model`,
      modelToken,
      tools: [
        {
          name: 'project.get',
          description: 'Read project',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
      notes: [],
    };
    let nextCount = 0;
    let followed = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, baseUrl.slice(0, -1));
      if (url.pathname === '/pi-model/responses') return fetch(input, init);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${workerToken}`);
      const json = (value: object) =>
        new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/pi-worker/next') {
        // The long answer's conversation asks again, from the checkpoint its answer saved.
        const again = upstreamStatus === 'long' && completions.length === 1 && !followed;
        if (again) followed = true;
        return json({
          work:
            ++nextCount === 1
              ? work
              : again
                ? {
                    ...work,
                    command: {
                      ...work.command,
                      id: 'cmd_fixture_2',
                      messages: [{ role: 'user', text: 'And briefly?' }],
                    },
                    checkpoint: {
                      content: completions[0].checkpoint,
                      hash: completions[0].checkpointHash,
                    },
                  }
                : null,
        });
      }
      if (url.pathname === '/pi-worker/begin')
        return json({ apply: ['cmd_fixture', 'cmd_fixture_2'].includes(String(body.commandId)) });
      if (url.pathname === '/pi-worker/progress') {
        assert.ok((body.events as typeof progress).length <= 32);
        progress.push(...(body.events as typeof progress));
        if (upstreamStatus === 'cancelled') controller.abort();
        return json({ accepted: upstreamStatus !== 'revoked' });
      }
      if (url.pathname === '/pi-worker/tool') {
        assert.equal(body.name, 'project.get');
        assert.deepEqual(body.input, {});
        toolInvocations++;
        return json({ result: { id: 'fixture-project' } });
      }
      if (url.pathname === '/pi-worker/complete') {
        completions.push(body as unknown as PiCompletion);
        if (upstreamStatus !== 'long' || completions.length === 2) controller.abort();
        return json({ saved: true });
      }
      if (url.pathname === '/pi-worker/fail') {
        failures.push(String(body.commandId));
        controller.abort();
        return json({ interrupted: true });
      }
      throw Error('Unexpected outbound request');
    };
    await runPiWorker(bootstrap, { signal: controller.signal, fetchImpl, pollIntervalMs: 250 });
    const failed =
      upstreamStatus === 400 || upstreamStatus === 'revoked' || upstreamStatus === 'cancelled';
    assert.deepEqual(failures, failed ? ['cmd_fixture'] : []);
    assert.equal(
      forwarded.length,
      upstreamStatus === 'reasoning'
        ? 3
        : upstreamStatus === 'tool' || upstreamStatus === 'long'
          ? 2
          : 1,
    );
    assert.equal(forwarded[0]?.model, 'gpt-6-luna');
    // No cap is sent: the model's own maximum ends an answer.
    assert.equal(forwarded[0]?.max_output_tokens, undefined);
    assert.deepEqual(forwarded[0]?.reasoning, { effort: 'none' });
    assert.equal(completions.length, failed ? 0 : upstreamStatus === 'long' ? 2 : 1);
    const expected =
      upstreamStatus === 'burst'
        ? burstText
        : upstreamStatus === 'long'
          ? longDeltas.join('')
          : 'Offline fixture complete';
    if (!failed) assert.equal(completions[0]?.messages[0]?.text, expected);
    if (upstreamStatus === 'burst' || upstreamStatus === 'long')
      assert.equal(
        progress
          .filter((event) => event.type === 'text')
          .map((event) => event.text)
          .join(''),
        expected + (upstreamStatus === 'long' ? 'Offline fixture complete' : ''),
      );
    if (upstreamStatus === 'long') {
      // The next turn sends the long answer back, its start and end, and the relay accepts it.
      const history = JSON.stringify(piResponsesSchema.parse(forwarded[1]).input);
      assert.match(history, /"0x{8191}1x/);
      assert.match(history, /characters left out/);
      assert.match(history, /79x+"/);
      assert.equal(completions[1]?.messages[0]?.text, 'Offline fixture complete');
    }
    if (upstreamStatus === 'revoked' || upstreamStatus === 'cancelled')
      assert.ok(progress.length > 0);
    assert.ok(progress.every((event) => event.text.length <= 8192));
    assert.ok(
      progress.every(
        (event) =>
          !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
            event.text,
          ),
      ),
    );
    assert.equal(
      toolInvocations,
      upstreamStatus === 'reasoning' ? 2 : upstreamStatus === 'tool' ? 1 : 0,
    );
    if (upstreamStatus === 'tool' || upstreamStatus === 'reasoning') {
      const secondRequest = piResponsesSchema.parse(forwarded[1]);
      assert.ok(validPiPayload(secondRequest, ['project_get']));
      assert.deepEqual(
        secondRequest.input.map((item) => ('type' in item ? item.type : item.role)),
        ['developer', 'user', 'function_call', 'function_call_output'],
      );
    }
    if (upstreamStatus === 'reasoning') {
      const thirdRequest = piResponsesSchema.parse(forwarded[2]);
      assert.ok(validPiPayload(thirdRequest, ['project_get']));
      const reasoning = thirdRequest.input.find(
        (item) => 'type' in item && item.type === 'reasoning',
      );
      assert.ok(reasoning && 'content' in reasoning);
      assert.deepEqual(reasoning.content, []);
      assert.equal(
        piResponsesSchema.safeParse({
          ...thirdRequest,
          input: thirdRequest.input.map((item) =>
            item === reasoning
              ? { ...item, content: [{ type: 'reasoning_text', text: 'not permitted' }] }
              : item,
          ),
        }).success,
        false,
      );
      assert.equal(
        validPiPayload(
          {
            ...thirdRequest,
            input: thirdRequest.input.map((item) =>
              item === reasoning ? { ...item, encrypted_content: '', summary: [] } : item,
            ),
          },
          ['project_get'],
        ),
        false,
      );
    }
  });

test('a conversation moved from Astra to Luna replays Astra’s reasoning to Astra only', async (context) => {
  const controller = new AbortController();
  const forwarded: Array<Record<string, unknown>> = [];
  const completions: PiCompletion[] = [];
  const grantEnds = expiresAt();
  let turn = { commandId: 'cmd_astra', model: 'gpt-6-astra' };
  const relay = new PiModelRelay({
    enabled: true,
    models: [
      { id: 'gpt-6-luna', effort: 'none' },
      { id: 'gpt-6-astra', effort: 'low' },
    ],
    providerKey: () => 'synthetic-provider-key',
    authority: {
      authorize: async () => ({
        id: `grant_${turn.commandId}`,
        userId: 'fixture-user',
        projectId: 'fixture-project',
        conversationId: 'pic_fixture',
        commandId: turn.commandId,
        runtimeId: 'flt_fixture',
        epoch: 1,
        expiresAt: grantEnds,
        model: turn.model,
        toolNames: ['project_get'],
      }),
      validate: async () => {},
    },
    fetchImpl: async (_input, init) => {
      forwarded.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return forwarded.length === 1
        ? mockReasoningToolResponse()
        : mockResponse(forwarded.length === 2 ? 'Astra done' : 'Luna done');
    },
  });
  const server = createServer((request, response) => void relay.handle(request, response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  context.after(() => {
    controller.abort();
    relay.close();
    server.closeAllConnections();
    server.close();
  });
  const command = (id: string, text: string): PiWork['command'] => ({
    id,
    conversationId: 'pic_fixture',
    hostId: 'pih_fixture',
    machine: 'standard',
    runtimeId: 'flt_fixture',
    epoch: 1,
    status: 'starting',
    messages: [{ role: 'user', text }],
    outcomes: [],
    error: null,
    createdAt: expiresAt(),
    expiresAt: expiresAt(),
    completedAt: null,
  });
  const work = (model: string, id: string, text: string): PiWork => ({
    command: command(id, text),
    checkpoint: completions[0]
      ? { content: completions[0].checkpoint, hash: completions[0].checkpointHash }
      : null,
    model,
    modelBaseUrl: `${baseUrl.slice(0, -1)}/pi-model`,
    modelToken,
    tools: [
      {
        name: 'project.get',
        description: 'Read project',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
    ],
    notes: [],
  });
  let served = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/pi-model/responses') return fetch(input, init);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const json = (value: object) =>
      new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/pi-worker/next') {
      // The person picks Luna between the two turns.
      const next =
        served === 0
          ? work('gpt-6-astra', 'cmd_astra', 'Check the project.')
          : served === 1 && completions.length === 1
            ? work('gpt-6-luna', 'cmd_luna', 'And now?')
            : null;
      if (next) served++;
      if (next?.model === 'gpt-6-luna') turn = { commandId: 'cmd_luna', model: 'gpt-6-luna' };
      return json({ work: next });
    }
    if (url.pathname === '/pi-worker/begin') return json({ apply: true });
    if (url.pathname === '/pi-worker/progress') return json({ accepted: true });
    if (url.pathname === '/pi-worker/tool') return json({ result: { id: 'fixture-project' } });
    if (url.pathname === '/pi-worker/complete') {
      completions.push(body as unknown as PiCompletion);
      if (completions.length === 2) controller.abort();
      return json({ saved: true });
    }
    controller.abort();
    return json({ interrupted: true });
  };
  await runPiWorker(
    {
      kind: 'pi',
      version: 2,
      baseUrl,
      hostId: 'pih_fixture',
      runtimeId: 'flt_fixture',
      epoch: 1,
      machine: 'standard',
      slots: 1,
      workerToken,
      expiresAt: expiresAt(),
    },
    { signal: controller.signal, fetchImpl, pollIntervalMs: 50 },
  );
  assert.deepEqual(
    completions.map((completion) => completion.messages.at(-1)?.text),
    ['Astra done', 'Luna done'],
  );
  const [first, second, third] = forwarded.map((body) => piResponsesSchema.parse(body));
  // The worker asks for no reasoning; the relay gives Astra its catalog effort.
  for (const astra of [first, second]) {
    assert.equal(astra.model, 'gpt-6-astra');
    assert.deepEqual(astra.reasoning, { effort: 'low' });
    assert.deepEqual(astra.include, ['reasoning.encrypted_content']);
  }
  // Within Astra's turn its encrypted reasoning goes back with the tool's result.
  assert.ok(
    second.input.some(
      (item) =>
        'type' in item &&
        item.type === 'reasoning' &&
        item.encrypted_content === 'synthetic-reasoning-signature',
    ),
  );
  // Luna reads the history without Astra's reasoning or its response item ids.
  assert.equal(third.model, 'gpt-6-luna');
  assert.deepEqual(third.reasoning, { effort: 'none' });
  assert.equal(third.include, undefined);
  assert.ok(!third.input.some((item) => 'type' in item && item.type === 'reasoning'));
  assert.doesNotMatch(JSON.stringify(third.input), /"fc_|rs_fixture/);
  assert.match(JSON.stringify(third.input), /Astra done/);
  assert.ok(validPiPayload(third, ['project_get']));
});
