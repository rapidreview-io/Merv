import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startProtocolProxy } from '../scripts/protocol-proxy.js';

for (const encoding of ['json', 'sse']) {
  test(`protocol proxy preserves ${encoding.toUpperCase()} traffic and records no credential or argument values`, async (t) => {
    const credential = 'SYNTHETIC_BEARER_MUST_NOT_APPEAR';
    const secretHeader = 'SYNTHETIC_HEADER_MUST_NOT_APPEAR';
    const secretArgument = 'SYNTHETIC_ARGUMENT_MUST_NOT_APPEAR';
    const secretResult = 'SYNTHETIC_RESULT_MUST_NOT_APPEAR';
    const received: { body: string; headers: IncomingHttpHeaders }[] = [];
    const result = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-11-25', secretResult, text: 'Retained \u2713' },
    });
    const responseBody = encoding === 'sse' ? `event: message\ndata: ${result}\n\n` : result;
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received.push({ body: Buffer.concat(chunks).toString('utf8'), headers: req.headers });
      res.writeHead(200, {
        'content-type': encoding === 'sse' ? 'text/event-stream' : 'application/json',
        'x-upstream-marker': 'retained',
      });
      // Split the response to prove the recorder leaves streamed bytes intact.
      res.write(responseBody.slice(0, 7));
      res.end(responseBody.slice(7));
    });
    t.after(async () => {
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const proxy = await startProtocolProxy(target);
    t.after(() => proxy.close());
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        clientInfo: { name: 'synthetic-agent', version: '1', secretArgument },
        arguments: { secretArgument },
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' },
      },
    });
    const response = await fetch(proxy.url + '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${credential}`,
        'x-synthetic-secret': secretHeader,
        'mcp-protocol-version': '2025-11-25',
      },
      body,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-upstream-marker'), 'retained');
    assert.equal(await response.text(), responseBody);
    assert.equal(received[0].body, body);
    assert.equal(received[0].headers.authorization, `Bearer ${credential}`);
    assert.equal(received[0].headers['x-synthetic-secret'], secretHeader);
    assert.equal(received[0].headers.host, new URL(target).host);
    assert.equal(proxy.observations.length, 1);
    const observation = proxy.observations[0];
    assert.deepEqual(observation.clientInfo, { name: 'synthetic-agent', version: '1' });
    assert.equal(observation.method, 'initialize');
    assert.equal(observation.protocolHeader, '2025-11-25');
    assert.equal(observation.envelopeVersion, '2025-11-25');
    assert.equal(observation.initializeVersion, '2025-11-25');
    assert.equal(observation.negotiatedVersion, '2025-11-25');
    assert.equal(observation.status, 200);
    assert.ok(observation.headerNames.includes('authorization'));
    for (const secret of [credential, secretHeader, secretArgument, secretResult])
      assert.ok(!JSON.stringify(proxy.observations).includes(secret));
    await proxy.close();
    await assert.rejects(fetch(proxy.url + '/mcp'));
  });
}

test('protocol observation refuses non-loopback origins and credentials in URLs', async () => {
  for (const target of [
    'https://sandboxes.rapidreview.io',
    'http://example.com',
    'http://user:secret@127.0.0.1:3081',
    'http://127.0.0.1:3081/mcp',
  ]) {
    await assert.rejects(startProtocolProxy(target), /HTTP loopback origin/);
  }
});
