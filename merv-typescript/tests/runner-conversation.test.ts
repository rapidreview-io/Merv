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
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Session } from '@merv/sessions/types';
import {
  forgetConversations,
  keepConversation,
  redactConversation,
  restoreConversation,
} from '../packages/runner/src/conversation.js';
import { launchCodexHome } from '../packages/runner/src/harness/codex.js';
import { claude as claudeHarness } from '../packages/runner/src/harness/claude.js';
import { codex as codexHarness } from '../packages/runner/src/harness/codex.js';
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
const continued =
  'You are continuing your earlier work on this unit. Read the current assignment and its context sections: they supersede anything earlier in this conversation (earlier plans, inputs, or feedback you already addressed).';
const launch = (profile: RunnerProfile, resume?: string, kept = true) =>
  buildLaunch(
    profile,
    {
      session: { ...offer('argv'), ...(kept && { continuity: { key: 'key' } }) } as Session,
      prompt: 'Worker prompt.',
      secret: bearer,
      mcpUrl: 'http://127.0.0.1:9/mcp',
      cwd: '/tmp',
      shellEnvFile: '/tmp/shell-env.sh',
      ...(resume && { resume }),
    },
    { PATH: '/usr/bin' },
  );

test('a launch that may be continued keeps its conversation; a resumed one names it, with one line before the prompt', () => {
  for (const profile of [claude(), codex]) {
    const fresh = launch(profile),
      resumed = launch(profile, id),
      unkept = launch(profile, undefined, false);
    const persistence = profile.harness === 'claude' ? '--no-session-persistence' : '--ephemeral';
    // A session nothing continues (a review, a named agent's) leaves no conversation behind.
    assert.deepEqual(
      unkept.args.filter((arg) => !fresh.args.includes(arg)),
      [persistence],
    );
    assert.ok(!fresh.args.includes(persistence) && !resumed.args.includes(persistence));
    assert.ok(!fresh.args.includes(id) && !fresh.stdin.includes('continuing'));
    assert.ok(resumed.stdin.startsWith(`${continued}\nWorker prompt.`));
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
    claudeHarness.conversationId(
      `noise\n{"type":"system","subtype":"init","session_id":"${id}"}\n`,
    ),
    id,
  );
  assert.equal(codexHarness.conversationId(`{"type":"thread.started","thread_id":"${id}"}\n`), id);
  assert.equal(
    codexHarness.conversationId('{"type":"thread.started","thread_id":"../x"}\n'),
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
    // A local Codex launch has a home of its own in its run directory, the machine's login linked.
    const own = launchCodexHome(profile, run, environment);
    assert.equal(own, profile.harness === 'codex' ? join(run, 'codex-home') : undefined);
    if (own) assert.equal(readlinkSync(join(own, 'auth.json')), join(root, 'codex', 'auth.json'));
    const path = restoreConversation(profile, run, cwd, id, bytes, environment);
    assert.match(
      path,
      profile.harness === 'claude'
        ? new RegExp(`/claude/projects/[A-Za-z0-9-]+/${id}\\.jsonl$`)
        : new RegExp(`/codex-home/sessions/\\d{4}/\\d{2}/\\d{2}/rollout-[0-9T-]+-${id}\\.jsonl$`),
    );
    const sides =
      profile.harness === 'claude'
        ? [
            `${path.slice(0, -'.jsonl'.length)}/tool-results`,
            ...['file-history', 'session-env'].map((d) => join(root, 'claude', d, id)),
          ]
        : [];
    for (const side of sides) mkdirSync(side, { recursive: true });
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
    forgetConversations(run, profile, undefined, environment);
    for (const left of [path, ...sides, ...(own ? [own] : [])])
      assert.equal(existsSync(left), false, `the shared home keeps nothing: ${left}`);
    assert.equal(keepConversation(run, profile, [], environment), undefined);
    // A conversation restored for a launch that never took it up is forgotten too.
    const unused = restoreConversation(profile, run, cwd, id, bytes, environment);
    rmSync(join(run, 'stdout.log'));
    forgetConversations(run, profile, id, environment);
    assert.equal(existsSync(unused), false);
  }
});

test('an inquiry visit forks a conversation in a shared Claude home and leaves the work visit running it alone', (t) => {
  const root = directory(t),
    work = directory(t),
    asking = directory(t),
    runWork = directory(t),
    runAsking = directory(t);
  const environment = { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'claude') };
  const profile = claude();
  const bytes = Buffer.from('{"type":"user","text":"the work so far"}\n');
  // The thread's work visit and an inquiry of it both resume the same conversation meanwhile.
  const own = restoreConversation(profile, runWork, work, id, bytes, environment);
  const copy = restoreConversation(profile, runAsking, asking, id, bytes, environment);
  const progressed = Buffer.concat([bytes, Buffer.from('{"type":"assistant","text":"more"}\n')]);
  writeFileSync(own, progressed);
  const sides = ['file-history', 'session-env'].map((d) => join(root, 'claude', d, id));
  for (const side of sides) mkdirSync(side, { recursive: true });
  // The inquiry's Claude forked it under an id of its own.
  const fork = '0199a0b2-2222-7222-8333-944445555666';
  const forked = join(dirname(copy), `${fork}.jsonl`);
  writeFileSync(forked, bytes);
  mkdirSync(join(root, 'claude', 'file-history', fork), { recursive: true });
  writeFileSync(
    join(runAsking, 'stdout.log'),
    `${JSON.stringify({ type: 'system', subtype: 'init', session_id: fork })}\n`,
  );
  writeFileSync(
    join(runWork, 'stdout.log'),
    `${JSON.stringify({ type: 'system', subtype: 'init', session_id: id })}\n`,
  );
  // The work visit keeps its own copy, however the home lists them.
  assert.deepEqual(
    keepConversation(runWork, profile, [], environment, work)?.size,
    progressed.length,
  );
  // The inquiry ends first: its fork and its copy go, the work visit's conversation stays.
  forgetConversations(runAsking, profile, id, environment, { cwd: asking });
  for (const gone of [copy, forked, join(root, 'claude', 'file-history', fork)])
    assert.equal(existsSync(gone), false, gone);
  for (const kept of [own, ...sides]) assert.equal(existsSync(kept), true, kept);
  assert.deepEqual(readFileSync(own), progressed);
});

test('redaction is JSON-safe: inside string values only, other lines as written', () => {
  const secret = 'S3cretValueOfTheRunner!',
    quoted = 'Quote"dSecretOfTheRunner';
  const lines = [
    { type: 'user', text: `token ${bearer} and ${secret}`, nested: [{ [bearer]: `"${secret}"` }] },
    { type: 'tool', output: `line\n${bearer}"`, count: 3, ok: true, none: null },
  ];
  const input = Buffer.from(
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\nnot json\n\nnot json ${secret}\n${JSON.stringify({ quoted })}\n{"kept":1}`,
  );
  const output = redactConversation(input, [secret, quoted]).toString('utf8');
  assert.ok(!output.includes(bearer) && !output.includes(secret) && !output.includes('Quote'));
  // A line with nothing to blank keeps its bytes; one that holds a secret but is no record is
  // dropped, and a secret JSON escapes is found as written.
  const [first, second, ...rest] = output.split('\n');
  assert.deepEqual(rest, ['not json', '{"quoted":"[REDACTED]"}', '{"kept":1}', '']);
  const parsed = [first!, second!].map((line) => JSON.parse(line));
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
if (at >= 0 && fs.existsSync(path.join(root, 'refuse-resume'))) { console.log('No conversation found with session ID: ' + args[at + 1]); process.exit(1); }
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
function continuing(
  t: TestContext,
  bytes: Buffer,
  recorded = bytes,
  stores = true,
  names = ['continued'],
) {
  const root = directory(t);
  const config = join(root, 'claude');
  mkdirSync(config);
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  t.after(() => {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  });
  const queue: Body[] = names.map((name) => ({
    ...offer(name),
    continuity: {
      key: 'key',
      resume: {
        sessionId: 'session_earlier',
        harness: 'claude',
        conversationId: id,
        sha256: createHash('sha256').update(recorded).digest('hex'),
        size: recorded.length,
      },
    },
  }));
  const work = queue[0]!;
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
          sessionId: decodeURIComponent(url.pathname.split('/')[2]!),
          sha256: body.sha256,
          size: body.size,
          uploadedAt: body.deliver && stores ? 'now' : null,
        },
      });
    }
    return await fake.fetch(input, init);
  };
  const f = machine(t, [claude(harness(root))], fetcher as typeof fetch);
  return { f, work, declared, config, fake };
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
      first: continued,
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

test('a harness that will not take up its restored conversation is put off once, then runs fresh', async (t) => {
  const earlier = Buffer.from('{"type":"user","first":"earlier turn"}\n');
  const { f, work, config, fake, declared } = continuing(t, earlier, earlier, true, [
    'once',
    'again',
  ]);
  writeFileSync(join(config, 'refuse-resume'), '');
  const runner = f.make();
  await runner.start();
  await until(
    runner,
    () =>
      fake.releases('session_again').length > 0 &&
      settled(f, 'session_again').conversation?.state === 'uploaded',
    'delivery',
  );
  // The first launch's failure to resume is no failure of the work, and nothing counts it.
  assert.deepEqual(
    fake.releases(work.id).map((call) => [call.body?.outcome, call.body?.deferral]),
    [['preparation_deferred', { cause: 'resume_failed', code: 'resume_failed' }]],
  );
  // The next launch of the same conversation on this machine starts afresh, and is kept.
  assert.deepEqual(settled(f, 'session_again').resumed, { unavailable: 'resume_failed_before' });
  assert.notEqual(declared.at(-1)!.conversationId, id);
  // The conversation restored for the launch that refused it was not left behind.
  for (const project of readdirSync(join(config, 'projects')))
    assert.ok(!readdirSync(join(config, 'projects', project)).includes(`${id}.jsonl`));
});
