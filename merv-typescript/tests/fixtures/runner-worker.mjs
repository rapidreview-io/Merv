/** A real child process and MCP client, with no model service or external network dependency. */
import assert from 'node:assert/strict';
import { renameSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const instruction = Buffer.concat(chunks).toString('utf8');
const token = process.env.MERV_AGENT_SESSION_TOKEN;
assert.match(token ?? '', /^ms_[A-Za-z0-9_-]{43}$/);
assert.equal(instruction.includes(token), false);
assert.equal(
  process.argv.some((argument) => argument.includes(token)),
  false,
);
assert.equal(
  Object.keys(process.env).some((key) => key.startsWith('MERV_RUNNER_INTEGRATION_')),
  false,
);
assert.equal(process.env.NODE_OPTIONS, undefined);
assert.equal(process.env.MERV_API_KEY, undefined);
assert.equal(process.env.RESEARCH_PLUGIN_TOKEN, undefined);

const client = new Client({ name: 'runner-actual-child-fixture', version: '1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(process.env.MERV_MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }),
);
const names = (await client.listTools()).tools.map((tool) => tool.name);
for (const forbidden of ['actor.create', 'task.create', 'workflow.begin'])
  assert.equal(names.includes(forbidden), false);
async function call(name, arguments_) {
  const response = await client.callTool({ name, arguments: arguments_ });
  assert.notEqual(response.isError, true, `MCP ${name} failed`);
  return JSON.parse(response.content.find((item) => item.type === 'text').text);
}
const task = await call('task.get', {});
assert.equal(instruction.includes(task.id), true, 'The frozen assignment was delivered on stdin');
const artifact = await call('artifact.create', {
  title: 'Actual runner child evidence',
  content: 'This evidence was created through MCP by a real isolated child process.',
});
await call('task.checkpoint', {
  notes: 'Actual child completed its restricted MCP checkpoint.',
  artifactIds: [artifact.id],
  requestId: 'runner-child-checkpoint',
});
await client.close();
// Written whole then renamed, so a poll never reads a half-written result.
writeFileSync(
  'worker-result.json.tmp',
  JSON.stringify({
    pid: process.pid,
    artifactId: artifact.id,
    actorId: artifact.createdBy,
    taskId: task.id,
    sourceEnvironmentAbsent: true,
    scopedCatalog: true,
    secretInArgvOrPrompt: false,
  }),
  { mode: 0o600 },
);
renameSync('worker-result.json.tmp', 'worker-result.json');

if (process.argv.includes('--hold')) {
  // The guardian must stop this process after remote halt, revocation, or controller disposal.
  setInterval(() => {}, 1000);
} else {
  // Leave time for the parent to observe a live child before it exits naturally.
  await new Promise((resolve) => setTimeout(resolve, 500));
  process.exitCode = process.argv.includes('--fail') ? 7 : 0;
}
