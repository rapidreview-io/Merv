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
  'oversize',
] as const)
  test(`pinned SDK worker and local Pi relay handle mock upstream ${upstreamStatus}`, async (context) => {
    const controller = new AbortController();
    const forwarded: Array<Record<string, unknown>> = [];
    const failures: string[] = [];
    const completions: PiCompletion[] = [];
    const progress: Array<{ type: string; text: string }> = [];
    const burstDeltas = Array.from({ length: 160 }, (_, index) => `[${index}]`);
    const burstText = burstDeltas.join('');
    const oversizeDeltas = Array.from({ length: 80 }, () => 'x'.repeat(8192));
    const grantExpiresAt = expiresAt();
    let toolInvocations = 0;
    const relay = new PiModelRelay({
      enabled: true,
      model: 'gpt-6-luna',
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
            : upstreamStatus === 'oversize'
              ? mockResponse(oversizeDeltas.join(''), oversizeDeltas)
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
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, baseUrl.slice(0, -1));
      if (url.pathname === '/pi-model/responses') return fetch(input, init);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${workerToken}`);
      const json = (value: object) =>
        new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/pi-worker/next')
        return json({ work: ++nextCount === 1 ? work : null });
      if (url.pathname === '/pi-worker/begin')
        return json({ apply: body.commandId === 'cmd_fixture' });
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
        controller.abort();
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
    assert.deepEqual(
      failures,
      upstreamStatus === 400 ||
        upstreamStatus === 'revoked' ||
        upstreamStatus === 'oversize' ||
        upstreamStatus === 'cancelled'
        ? ['cmd_fixture']
        : [],
    );
    assert.equal(
      forwarded.length,
      upstreamStatus === 'reasoning' ? 3 : upstreamStatus === 'tool' ? 2 : 1,
    );
    assert.equal(forwarded[0]?.model, 'gpt-6-luna');
    assert.equal(forwarded[0]?.max_output_tokens, 4096);
    assert.deepEqual(forwarded[0]?.reasoning, { effort: 'none' });
    assert.equal(
      completions.length,
      upstreamStatus === 400 ||
        upstreamStatus === 'revoked' ||
        upstreamStatus === 'oversize' ||
        upstreamStatus === 'cancelled'
        ? 0
        : 1,
    );
    if (
      upstreamStatus !== 400 &&
      upstreamStatus !== 'revoked' &&
      upstreamStatus !== 'oversize' &&
      upstreamStatus !== 'cancelled'
    )
      assert.equal(
        completions[0]?.messages[0]?.text,
        upstreamStatus === 'burst' ? burstText : 'Offline fixture complete',
      );
    if (upstreamStatus === 'burst')
      assert.equal(
        progress
          .filter((event) => event.type === 'text')
          .map((event) => event.text)
          .join(''),
        burstText,
      );
    if (upstreamStatus === 'revoked' || upstreamStatus === 'cancelled')
      assert.ok(progress.length > 0);
    assert.ok(progress.every((event) => event.text.length <= 8192));
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
