/**
 * A stand-in Claude Code for an inquiry visit: it checks what its runner launched it with and
 * restored for it, and answers over Merv's MCP as a resumed agent would. No model is called.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const args = process.argv.slice(2);
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const resume = value('--resume');
const root = process.env.CLAUDE_CONFIG_DIR;
/** The conversation its runner restored where Claude Code finds the one it resumes. */
const find = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = find(path);
      if (found) return found;
    } else if (entry.name === `${resume}.jsonl`) return path;
  }
  return undefined;
};
const restored = resume ? find(join(root, 'projects')) : undefined;
// Forked, as Claude Code does with --fork-session: the conversation goes on under a new id.
const forked = args.includes('--fork-session');
console.log(
  JSON.stringify({ type: 'system', subtype: 'init', session_id: forked ? randomUUID() : resume }),
);

const client = new Client({ name: 'inquiry-agent-fixture', version: '1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(process.env.MERV_MCP_URL), {
    requestInit: {
      headers: { authorization: `Bearer ${process.env.MERV_AGENT_SESSION_TOKEN}` },
    },
  }),
);
const names = (await client.listTools()).tools.map((tool) => tool.name);
const call = async (name, input) => {
  try {
    const response = await client.callTool({ name, arguments: input });
    return response.isError
      ? { error: true }
      : JSON.parse(response.content.find((item) => item.type === 'text').text);
  } catch {
    return { error: true };
  }
};
const inbox = await call('session.messages', {});
const question = Array.isArray(inbox) ? inbox[0] : undefined;
const write = await call('session.message', {
  threadId: question?.threadId ?? 'thr_x',
  body: 'A write the inquiry must not make',
  requestId: 'inquiry-write',
});
writeFileSync(
  join(root, 'inquiry-agent.json'),
  JSON.stringify({
    resume,
    restored: restored ? readFileSync(restored, 'utf8') : null,
    tools: value('--tools'),
    forked,
    inquiryPrompt: /inquiry/.test(prompt),
    catalogWrites: ['session.message', 'session.ask_owner', 'usage.set_budget'].some((name) =>
      names.includes(name),
    ),
    writeRefused: write.error === true,
  }),
);
writeFileSync(
  process.env.MERV_USAGE_FILE,
  JSON.stringify({ inputTokens: 4000, outputTokens: 321 }),
);
// The reply ends the visit; its runner stops this process once it sees that.
await call('session.message.ack', {
  messageId: question?.id,
  reply: 'I concluded the second method is better.',
  requestId: 'inquiry-reply',
});
await client.close();
