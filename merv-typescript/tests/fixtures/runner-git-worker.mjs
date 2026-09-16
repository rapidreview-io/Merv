import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
assert.ok(prompt.includes('Frozen assignment:'));
const client = new Client({ name: 'real-git-worker', version: '1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(process.env.MERV_MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${process.env.MERV_AGENT_SESSION_TOKEN}` } },
  }),
);
writeFileSync('worker-output.txt', 'Preserved through the native runner workspace lifecycle.\n');
const artifact = await client.callTool({
  name: 'artifact.create',
  arguments: {
    title: 'Workspace evidence',
    content: 'A real child wrote worker-output.txt before handoff.',
  },
});
assert.notEqual(artifact.isError, true);
const finish = await client.callTool({ name: 'step.finish', arguments: {} });
assert.notEqual(finish.isError, true);
await client.close();
// The controller may observe the handoff and stop this worker before natural exit.
setInterval(() => {}, 1000);
