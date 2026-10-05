/**
 * Continuity on the runner: the argv of a resumed and a fresh launch, where a conversation is
 * restored and found again, its JSON-safe redaction, and a launch against the stand-in Sessions
 * server with a stand-in Claude Code that resumes, or is launched fresh when the bytes are wrong.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@merv/sessions/types';
import {
  conversationId,
  keepConversation,
  redactConversation,
  restoreConversation,
} from '../packages/runner/src/conversation.js';
import { buildLaunch, type RunnerProfile } from '../packages/runner/src/profiles.js';
import {
  launchId,
  machine,
  metadata,
  offer,
  server,
  until,
  type Body,
} from './fixtures/runner-stand-in.js';

const directory = (t: TestContext) => {
  const path = mkdtempSync(join(tmpdir(), 'merv-conversation-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
const id = '0199a0b2-1111-7222-8333-944445555666';
const bearer = `ms_${'A'.repeat(43)}`;
const claude = (executable = '/usr/local/bin/claude'): RunnerProfile => ({
  name: 'claude',
  harness: 'claude',
  executable,
  enabled: true,
  parallelism: 1,
});
const codex: RunnerProfile = {
  name: 'codex',
  harness: 'codex',
  executable: '/usr/local/bin/codex',
  enabled: true,
  parallelism: 1,
};
const launch = (profile: RunnerProfile, resume?: string) =>
  buildLaunch(
    profile,
    {
      session: offer('argv') as unknown as Session,
      prompt: 'Worker prompt.',
      secret: bearer,
      mcpUrl: 'http://127.0.0.1:9/mcp',
      cwd: '/tmp',
      shellEnvFile: '/tmp/shell-env.sh',
      ...(resume && { resume }),
    },
    { PATH: '/usr/bin' },
  );

test('a fresh launch keeps its conversation; a resumed one names it, with one line before the prompt', () => {
  for (const profile of [claude(), codex]) {
    const fresh = launch(profile),
      resumed = launch(profile, id);
    assert.ok(
      !fresh.args.includes('--no-session-persistence') && !fresh.args.includes('--ephemeral'),
    );
    assert.ok(!fresh.args.includes(id) && !fresh.stdin.includes('continuing'));
    assert.ok(
      resumed.stdin.startsWith(
        'You are continuing your earlier work on this unit; it was returned to you with review feedback.\nWorker prompt.',
      ),
    );
    assert.equal(resumed.stdin.slice(resumed.stdin.indexOf('\n') + 1), fresh.stdin);
    if (profile.harness === 'claude') {
      assert.deepEqual(
        resumed.args.filter((arg) => !fresh.args.includes(arg)),
        ['--resume', id],
      );
      assert.equal(resumed.args[resumed.args.indexOf('--resume') + 1], id);
    } else {
      // `exec <its options> resume <thread> -`: the same options, the thread before stdin's dash.
      assert.deepEqual(resumed.args.slice(-3), ['resume', id, '-']);
      assert.deepEqual(resumed.args.slice(0, -3), fresh.args.slice(0, -1));
    }
  }
  assert.throws(() => launch(claude(), 'not-a-uuid'), { code: 'invalid_runner_launch' });
});

test('the id the harness printed first; a conversation restored is found and taken out again', (t) => {
  assert.equal(
    conversationId('claude', `noise\n{"type":"system","subtype":"init","session_id":"${id}"}\n`),
    id,
  );
  assert.equal(conversationId('codex', `{"type":"thread.started","thread_id":"${id}"}\n`), id);
  assert.equal(
    conversationId('codex', '{"type":"thread.started","thread_id":"../x"}\n'),
    undefined,
  );
  for (const profile of [claude(), codex]) {
    const root = directory(t),
      cwd = directory(t),
      run = directory(t);
    const environment = {
      HOME: root,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'),
    };
    const bytes = Buffer.from('{"type":"user","text":"hello"}\n');
    const path = restoreConversation(profile, cwd, id, bytes, environment);
    assert.match(
      path,
      profile.harness === 'claude'
        ? new RegExp(`/claude/projects/[A-Za-z0-9-]+/${id}\\.jsonl$`)
        : new RegExp(`/codex/sessions/\\d{4}/\\d{2}/\\d{2}/rollout-[0-9T-]+-${id}\\.jsonl$`),
    );
    assert.deepEqual(readFileSync(path), bytes);
    const event =
      profile.harness === 'claude'
        ? { type: 'system', subtype: 'init', session_id: id }
        : { type: 'thread.started', thread_id: id };
    writeFileSync(join(run, 'stdout.log'), `${JSON.stringify(event)}\n`);
    const facts = keepConversation(run, profile, [], environment)!;
    assert.deepEqual(facts, {
      harness: profile.harness,
      conversationId: id,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    });
    assert.deepEqual(readFileSync(join(run, 'conversation.jsonl')), bytes);
    assert.equal(existsSync(path), false, 'the shared home keeps no conversation');
    assert.equal(keepConversation(run, profile, [], environment), undefined);
  }
});

test('redaction is JSON-safe: inside string values only, every line still a record', () => {
  const secret = 'S3cretValueOfTheRunner!';
  const lines = [
    { type: 'user', text: `token ${bearer} and ${secret}`, nested: [{ [bearer]: `"${secret}"` }] },
    { type: 'tool', output: `line\n${bearer}"`, count: 3, ok: true, none: null },
  ];
  const input = Buffer.from(
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\nnot json\n\n`,
  );
  const output = redactConversation(input, [secret]).toString('utf8');
  assert.ok(!output.includes(bearer) && !output.includes(secret));
  const parsed = output
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(parsed, [
    {
      type: 'user',
      text: 'token [REDACTED] and [REDACTED]',
      nested: [{ '[REDACTED]': '"[REDACTED]"' }],
    },
    { type: 'tool', output: 'line\n[REDACTED]"', count: 3, ok: true, none: null },
  ]);
});

/** A stand-in Claude Code: resumes the named conversation or starts one, says so, appends a turn. */
const harness = (root: string) => {
  const path = join(root, 'claude-stand-in.cjs');
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const args = process.argv.slice(2), at = args.indexOf('--resume'), root = process.env.CLAUDE_CONFIG_DIR;
const input = fs.readFileSync(0, 'utf8');
let id = at >= 0 ? args[at + 1] : crypto.randomUUID(), file;
if (at >= 0) {
  for (const project of fs.readdirSync(path.join(root, 'projects')))
    if (fs.existsSync(path.join(root, 'projects', project, id + '.jsonl'))) file = path.join(root, 'projects', project, id + '.jsonl');
  if (!file) { console.log('No conversation found with session ID: ' + id); process.exit(1); }
} else {
  fs.mkdirSync(path.join(root, 'projects', '-fresh'), { recursive: true });
  file = path.join(root, 'projects', '-fresh', id + '.jsonl');
}
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: id, resumed: at >= 0 }));
fs.appendFileSync(file, JSON.stringify({ type: 'user', first: input.split('\\n')[0], bearer: process.env.MERV_AGENT_SESSION_TOKEN }) + '\\n');
`,
  );
  chmodSync(path, 0o755);
  return path;
};
/** The stand-in server, with the routes a continued session's runner calls and a store. */
function continuing(t: TestContext, bytes: Buffer, recorded = bytes, stores = true) {
  const root = directory(t);
  const config = join(root, 'claude');
  mkdirSync(config);
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  t.after(() => {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  });
  const work = offer('continued');
  work.continuity = {
    key: 'key',
    resume: {
      sessionId: 'session_earlier',
      harness: 'claude',
      conversationId: id,
      sha256: createHash('sha256').update(recorded).digest('hex'),
      size: recorded.length,
    },
  };
  const queue = [work];
  const fake = server(() => queue.shift() ?? null);
  const declared: Body[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === '/blob') return new Response(new Uint8Array(bytes));
    if (url.pathname.endsWith('/resume'))
      return Response.json({ download: { url: 'http://127.0.0.1:9/blob', expiresAt: 'later' } });
    if (url.pathname.endsWith('/conversation')) {
      const body = JSON.parse(String(init!.body));
      declared.push(body);
      return Response.json({
        conversation: {
          sessionId: work.id,
          sha256: body.sha256,
          size: body.size,
          uploadedAt: body.deliver && stores ? 'now' : null,
        },
      });
    }
    return await fake.fetch(input, init);
  };
  const f = machine(t, [claude(harness(root))], fetcher as typeof fetch);
  return { f, work, declared, config };
}
const settled = (f: ReturnType<typeof machine>, sessionId: string) =>
  metadata(f.config.directory, launchId(sessionId));

test('a resumed launch continues the restored conversation and keeps it again, redacted', async (t) => {
  const earlier = Buffer.from('{"type":"user","first":"earlier turn"}\n');
  const { f, work, declared, config } = continuing(t, earlier);
  const runner = f.make();
  await runner.start();
  await until(runner, () => settled(f, work.id).conversation?.state === 'uploaded', 'delivery');
  const kept = settled(f, work.id);
  assert.equal(kept.resumed, id);
  assert.deepEqual(
    declared.map((body) => [body.harness, body.conversationId, !!body.deliver]),
    [
      ['claude', id, false],
      ['claude', id, true],
    ],
  );
  // The earlier turn, then this launch's: its first line the continuation, its bearer blanked.
  const runs = join(
    f.config.directory,
    'launches',
    createHash('sha256').update(launchId(work.id)).digest('hex'),
  );
  const turns = readFileSync(join(runs, 'conversation.jsonl'), 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(turns, [
    { type: 'user', first: 'earlier turn' },
    {
      type: 'user',
      first:
        'You are continuing your earlier work on this unit; it was returned to you with review feedback.',
      bearer: '[REDACTED]',
    },
  ]);
  // Nothing is left in the machine's own Claude home.
  for (const project of readdirSync(join(config, 'projects')))
    assert.deepEqual(readdirSync(join(config, 'projects', project)), []);
});

test('a conversation whose bytes are not the ones recorded launches fresh and says why', async (t) => {
  const { f, work, declared } = continuing(
    t,
    Buffer.from('{"type":"user"}\n'),
    Buffer.from('{"type":"usex"}\n'),
  );
  const runner = f.make();
  await runner.start();
  await until(runner, () => settled(f, work.id).conversation?.state === 'uploaded', 'delivery');
  const kept = settled(f, work.id);
  assert.deepEqual(kept.resumed, { unavailable: 'resume_hash_mismatch' });
  // The fresh conversation is the one kept now, under the id the harness printed.
  assert.notEqual(declared[0]!.conversationId, id);
});

test('a launch whose conversation is still owed stays pending once its transcript is settled', async (t) => {
  const { f, work } = continuing(
    t,
    Buffer.from('{"type":"user","first":"earlier turn"}\n'),
    undefined,
    false,
  );
  const runner = f.make();
  await runner.start();
  await until(runner, () => (settled(f, work.id).conversation?.tries ?? 0) > 0, 'a delivery try');
  // This stand-in has no transcript route: the transcript is settled, the conversation owed.
  assert.notEqual(settled(f, work.id).transcript?.state, 'owed');
  assert.equal(settled(f, work.id).conversation?.state, 'owed');
  // A hosted machine leaves once nothing is pending: not before the conversation is delivered.
  assert.equal(runner.snapshot().launches[0]?.transcriptPending, true);
});
