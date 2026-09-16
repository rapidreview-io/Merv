import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

for await (const _chunk of process.stdin) {
  /* Consume frozen assignment before starting. */
}
const client = new Client({ name: 'live-code-operation-fixture', version: '1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(process.env.MERV_MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${process.env.MERV_AGENT_SESSION_TOKEN}` } },
  }),
);
const call = async (name, input) => {
  const result = await client.callTool({ name, arguments: input });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content.find((item) => item.type === 'text').text);
};
const expectedHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
writeFileSync('answer.txt', '42\n');
const input = { expectedHead, message: 'Preserve the verified answer', requestId: 'checkpoint-1' };
let operation = await call('code.commit', input);
const replay = await call('code.commit', input);
assert.equal(replay.command.id, operation.command.id);
const deadline = Date.now() + 25_000;
while (operation.status !== 'succeeded') {
  assert.ok(['queued', 'dispatched'].includes(operation.status), JSON.stringify(operation));
  assert.ok(Date.now() < deadline, 'Code operation did not receive a commit receipt');
  await delay(60);
  operation = await call('code.operation', { commandId: operation.command.id });
}
assert.equal(operation.receipt.parentOid, expectedHead);
assert.notEqual(operation.receipt.headOid, expectedHead);
assert.equal(
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  operation.receipt.headOid,
);
const artifact = await call('artifact.create', {
  title: 'Commit evidence authored by the live producer',
  content: JSON.stringify(operation.receipt),
  mediaType: 'application/json',
});
// A final recovery capture must not alter the earlier named checkpoint receipt.
writeFileSync('later.txt', 'This later edit was not part of the named checkpoint.\n');
await call('step.finish', { commandId: operation.command.id, artifactId: artifact.id });
await client.close();
setInterval(() => {}, 1000);
