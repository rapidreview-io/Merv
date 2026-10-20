import { createService, MervError } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { ProjectScope } from '@merv/scope';
import type {
  AgentLoginCodeMail,
  AgentLoginLimits,
  AgentLoginNotice,
  AgentLoginStarted,
  DirectoryUser,
  Principal,
} from '@merv/contracts';
import { openState } from './fixtures/state.js';
import { connectServer } from './fixtures/agent-login.js';
import { clientIp, scopeApiPlugin } from '@merv/scope/api';
import {
  addressBucket,
  Admission,
  agentLoginSchema,
  proxyList,
  startInput,
} from '@merv/scope/connect';
import { Context } from 'cordis';

const issuer = 'https://identity.example/auth/v1';
const ada = '11111111-1111-4111-8111-111111111111';
const day = 86_400_000;
export const limits: AgentLoginLimits = {
  emailPer15Minutes: 3,
  emailPerDay: 10,
  ipPerHour: 10,
  globalPerMinute: 30,
  globalPerDay: 500,
  triesPerLogin: 5,
  keysPerPerson: 10,
  keyDays: 90,
  retentionDays: 30,
};
const verifierHash = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');

async function fixture(t: TestContext) {
  const state = await openState();
  t.after(() => state.close());
  let time = Date.parse('2026-10-20T12:00:00.000Z');
  const scope = await createService(new ProjectScope(state, () => time));
  const person = await scope.members.acceptVerifiedIdentity({
    issuer,
    subject: ada,
    expiresAt: new Date(time + 3_600_000).toISOString(),
  });
  const project = await scope.members.createProject(person, { name: 'Grokking', requestId: 'g' });
  const directoryUsers = new Map<string, DirectoryUser | Error>([
    [
      ada,
      { email: 'Ada@Lab.org', anonymous: false, confirmed: true, banned: false, deleted: false },
    ],
  ]);
  const accounts = new Map<string, string>([['ada@lab.org', ada]]);
  const directory = {
    find: async (email: string) => {
      const subject = accounts.get(email.toLowerCase());
      return subject ? { issuer, subject } : null;
    },
    user: async (subject: string) => {
      const user = directoryUsers.get(subject) ?? null;
      if (user instanceof Error) throw user;
      return user;
    },
  };
  const codes: AgentLoginCodeMail[] = [];
  const notices: AgentLoginNotice[] = [];
  let mailFails = false;
  const send = async (mail: AgentLoginCodeMail) => {
    if (mailFails) throw new Error('synthetic mail failure');
    codes.push(mail);
  };
  const notify = async (notice: AgentLoginNotice) => {
    if (mailFails) throw new Error('synthetic mail failure');
    notices.push(notice);
  };
  let verifiers = 0;
  /** Starts a login the way a connector does, and delivers its code in the foreground. */
  async function start(
    email = 'ada@lab.org',
    {
      installId = '9d5c3a1e-5f0e-4b8c-9a39-4f1e2b7c6d01',
      ip = '203.0.113.7' as string | null,
      with: given = limits,
      hold = false,
    } = {},
  ) {
    const verifier = `verifier-${++verifiers}`.padEnd(43, 'v');
    const login = await scope.agentLogins.start(
      {
        email,
        ip,
        client: { name: 'Claude Code', host: 'ada-mbp', installId },
        verifierHash: verifierHash(verifier),
      },
      given,
    );
    if (!hold) await deliver(login, email, given);
    return { login, verifier };
  }
  const deliver = (login: AgentLoginStarted, email = 'ada@lab.org', given = limits) =>
    scope.agentLogins.deliver(login, email, given, directory, send);
  const verify = (login: AgentLoginStarted, verifier: string, code = login.code) =>
    scope.agentLogins.verify(login.loginId, { code, verifier }, limits, directory, notify);
  const principal = async (token: string): Promise<Principal> => ({
    kind: 'key',
    key: await scope.userKeys.authenticate(token),
  });
  return {
    state,
    scope,
    person,
    project,
    directoryUsers,
    accounts,
    directory,
    codes,
    notices,
    start,
    deliver,
    verify,
    principal,
    failMail: (value: boolean) => {
      mailFails = value;
    },
    now: () => time,
    /** The person signed in now, as the Keys page would be. */
    human: () =>
      scope.members.acceptVerifiedIdentity({
        issuer,
        subject: ada,
        expiresAt: new Date(time + 3_600_000).toISOString(),
      }),
    advance: (ms: number) => {
      time += ms;
    },
  };
}

const invalidCode = (error: unknown) =>
  error instanceof MervError &&
  error.code === 'invalid_code' &&
  error.status === 400 &&
  error.message === 'That code does not match this sign-in. Check it, or run login again.';

test('only an eligible account is mailed its code, and every start answers alike', async (t) => {
  const f = await fixture(t);
  const { login } = await f.start();
  assert.match(login.code, /^\d{8}$/);
  assert.match(login.phrase, /^[a-z]+ [a-z]+$/);
  assert.deepEqual(f.codes, [
    {
      to: 'Ada@Lab.org',
      loginId: login.loginId,
      code: login.code,
      phrase: login.phrase,
      label: 'Claude Code on ada-mbp',
    },
  ]);
  // A known address whose account is not eligible is mailed nothing; so is an unknown one.
  const record = f.directoryUsers.get(ada) as DirectoryUser;
  for (const change of [
    { anonymous: true },
    { confirmed: false },
    { banned: true },
    { deleted: true },
    { email: 'someone-else@lab.org' },
  ]) {
    f.directoryUsers.set(ada, { ...record, ...change });
    f.advance(16 * 60_000);
    await f.start();
    assert.equal(f.codes.length, 1, JSON.stringify(change));
  }
  f.directoryUsers.set(ada, new MervError('directory_unavailable', 'down', 503));
  f.advance(16 * 60_000);
  await f.start();
  f.directoryUsers.set(ada, record);
  f.failMail(true);
  f.advance(16 * 60_000);
  await f.start();
  f.failMail(false);
  f.advance(16 * 60_000);
  await f.start('nobody@lab.org');
  // Signed up on the web but never signed in to Merv: no Merv identity, no code.
  f.accounts.set('new@lab.org', '22222222-2222-4222-8222-222222222222');
  await f.start('new@lab.org');
  // Signed in, but with no project to anchor a key.
  const loner = await f.scope.members.acceptVerifiedIdentity({
    issuer,
    subject: '33333333-3333-4333-8333-333333333333',
    expiresAt: new Date(f.now() + 3_600_000).toISOString(),
  });
  f.accounts.set('loner@lab.org', loner.user.subject);
  f.directoryUsers.set(loner.user.subject, { ...record, email: 'loner@lab.org' });
  // They are mailed nothing, and nothing they hold signs in.
  const lonely = await f.start('loner@lab.org');
  assert.equal(f.codes.length, 1);
  await assert.rejects(f.verify(lonely.login, lonely.verifier), invalidCode);
  const rows = await f.state.read((sql) =>
    sql.all<{ issuer: string | null; sent_at: string | null }>(
      'SELECT issuer,sent_at FROM agent_logins ORDER BY created_at',
    ),
  );
  assert.equal(rows.length, 11);
  assert.equal(rows.filter((row) => row.sent_at !== null).length, 1);
  assert.equal(rows.at(-1)!.issuer, null);
  const stored = JSON.stringify(
    await f.state.read((sql) => sql.all('SELECT * FROM agent_logins')),
  ).toLowerCase();
  assert.ok(!stored.includes('ada@lab.org') && !stored.includes(login.code));
});

test('a code signs in once, only with its own verifier, and a wrong try locks only its login', async (t) => {
  const f = await fixture(t);
  const first = await f.start();
  const second = await f.start();
  let writes = 0;
  const transaction = f.state.transaction.bind(f.state);
  f.state.transaction = ((fn: never) => {
    writes++;
    return transaction(fn);
  }) as typeof f.state.transaction;
  await assert.rejects(f.verify(first.login, second.verifier), invalidCode);
  await assert.rejects(f.verify(first.login, 'x'.repeat(43)), invalidCode);
  await assert.rejects(
    f.scope.agentLogins.verify(
      'login_missing',
      { code: '00000000', verifier: first.verifier },
      limits,
      f.directory,
      async () => undefined,
    ),
    invalidCode,
  );
  assert.equal(writes, 0, 'no writer lock without the verifier');
  const wrong = first.login.code === '00000000' ? '00000001' : '00000000';
  for (let i = 0; i < 5; i++)
    await assert.rejects(f.verify(first.login, first.verifier, wrong), invalidCode);
  await assert.rejects(f.verify(first.login, first.verifier), invalidCode, 'locked after 5');
  const issued = await f.verify(second.login, second.verifier);
  assert.match(issued.token, /^mk_/);
  assert.equal(issued.key.label, 'Claude Code on ada-mbp');
  assert.equal(issued.email, 'Ada@Lab.org');
  assert.deepEqual(issued.projects, [{ ...f.project, role: 'operator' }]);
  assert.deepEqual(
    f.notices.map(({ keyId, label, phrase, to }) => ({ keyId, label, phrase, to })),
    [
      {
        keyId: issued.key.id,
        label: issued.key.label,
        phrase: second.login.phrase,
        to: 'Ada@Lab.org',
      },
    ],
  );
  await assert.rejects(f.verify(second.login, second.verifier), invalidCode, 'single use');
  const caller = await f.scope.caller(await f.principal(issued.token), f.project.id);
  assert.equal(caller.key?.id, issued.key.id);
  const rows = await f.state.read((sql) =>
    sql.all<{ status: string; key_id: string | null; failures: number }>(
      'SELECT status,key_id,failures FROM agent_logins ORDER BY status',
    ),
  );
  assert.deepEqual(rows, [
    { status: 'locked', key_id: null, failures: 5 },
    { status: 'used', key_id: issued.key.id, failures: 0 },
  ]);
});

test('expired, ineligible and revalidation failures answer as a wrong code does', async (t) => {
  const f = await fixture(t);
  const record = f.directoryUsers.get(ada) as DirectoryUser;
  const expired = await f.start();
  f.advance(10 * 60_000 + 1);
  await assert.rejects(f.verify(expired.login, expired.verifier), invalidCode);
  // Never mailed: the right code still finds no eligible account behind the login.
  f.advance(16 * 60_000);
  f.directoryUsers.set(ada, { ...record, confirmed: false });
  const unmailed = await f.start();
  f.directoryUsers.set(ada, record);
  await assert.rejects(f.verify(unmailed.login, unmailed.verifier), invalidCode);
  // Banned between start and verify: refused, and that login locks.
  const banned = await f.start();
  f.directoryUsers.set(ada, { ...record, banned: true });
  await assert.rejects(f.verify(banned.login, banned.verifier), invalidCode);
  f.directoryUsers.set(ada, record);
  await assert.rejects(f.verify(banned.login, banned.verifier), invalidCode, 'stays locked');
  // An unreachable directory consumes nothing: the same login verifies once it answers.
  f.advance(16 * 60_000);
  const waiting = await f.start();
  f.directoryUsers.set(ada, new MervError('directory_unavailable', 'down', 503));
  await assert.rejects(f.verify(waiting.login, waiting.verifier), {
    code: 'directory_unavailable',
    status: 503,
  });
  f.directoryUsers.set(ada, record);
  assert.match((await f.verify(waiting.login, waiting.verifier)).token, /^mk_/);
});

test('a key whose notice cannot be sent is revoked before anyone holds it', async (t) => {
  const f = await fixture(t);
  const { login, verifier } = await f.start();
  f.failMail(true);
  await assert.rejects(f.verify(login, verifier), { code: 'notice_failed', status: 503 });
  const keys = await f.scope.userKeys.keys(await f.human());
  assert.equal(keys.length, 1);
  assert.notEqual(keys[0]!.revokedAt, null);
});

test('starts are capped per email and per address, before any mail', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) await f.start('ada@lab.org', { ip: `198.51.100.${i}` });
  await assert.rejects(f.start('ada@lab.org', { ip: '198.51.100.9' }), (error: unknown) => {
    assert.ok(error instanceof MervError);
    assert.equal(error.code, 'login_rate_limited');
    assert.equal(error.status, 429);
    assert.deepEqual(error.details, { retryAfterSeconds: 900 });
    return true;
  });
  for (let i = 0; i < 10; i++) await f.start(`unknown${i}@lab.org`);
  await assert.rejects(f.start('another@lab.org'), { code: 'login_rate_limited' }, 'per address');
  await f.start('another@lab.org', { ip: null });
  f.advance(24 * 60 * 60_000);
  for (let i = 0; i < 10; i++) {
    await f.start('ada@lab.org', { ip: null });
    f.advance(15 * 60_000);
  }
  await assert.rejects(f.start('ada@lab.org', { ip: null }), { code: 'login_rate_limited' });
});

test('the caps in all count codes sent, so a flood of unknown addresses spends none of them', async (t) => {
  const f = await fixture(t);
  const tight = { ...limits, globalPerMinute: 2, globalPerDay: 3 };
  // Far more starts than either cap, from many addresses, for addresses nobody holds.
  for (let i = 0; i < 40; i++)
    await f.start(`ghost${i}@lab.org`, { ip: `198.51.100.${i % 8}`, with: tight });
  const first = await f.start('ada@lab.org', { with: tight });
  assert.equal(f.codes.length, 1);
  // Two starts admitted before either is sent: reserving the send holds the cap exactly.
  const held = [
    await f.start('ada@lab.org', { with: tight, hold: true }),
    await f.start('ada@lab.org', { with: tight, hold: true }),
  ];
  for (const { login } of held) await f.deliver(login, 'ada@lab.org', tight);
  assert.equal(f.codes.length, 2);
  await assert.rejects(f.start('ghost@lab.org', { with: tight }), {
    code: 'login_capacity',
    status: 429,
    details: { retryAfterSeconds: 60 },
  });
  // Past the cap on sends, a code already sent still signs in.
  assert.match((await f.verify(first.login, first.verifier)).token, /^mk_/);
  f.advance(16 * 60_000);
  await f.start('ada@lab.org', { with: tight });
  assert.equal(f.codes.length, 3);
  f.advance(16 * 60_000);
  await assert.rejects(f.start('ada@lab.org', { with: tight }), {
    code: 'login_capacity',
    details: { retryAfterSeconds: 41_280 },
  });
});

test('unsuccessful requests are pruned after 30 days; issuance evidence is kept', async (t) => {
  const f = await fixture(t);
  const used = await f.start();
  await f.verify(used.login, used.verifier);
  await f.start('nobody@lab.org');
  f.advance(31 * day);
  await f.start('nobody@lab.org');
  const statuses = await f.state.read((sql) =>
    sql.all<{ key_id: string | null }>('SELECT key_id FROM agent_logins ORDER BY created_at'),
  );
  assert.equal(statuses.length, 2);
  assert.ok(statuses[0]!.key_id);
  await assert.rejects(
    f.state.transaction((tx) => tx.run('DELETE FROM agent_logins WHERE key_id IS NOT NULL')),
  );
  assert.equal(
    (await f.state.read((sql) => sql.all('SELECT 1 FROM agent_logins WHERE key_id IS NOT NULL')))
      .length,
    1,
  );
});

test('one key per connector install, ten per person, labelled, recorded, and fixed at 90 days', async (t) => {
  const f = await fixture(t);
  const install = (n: number) => `9d5c3a1e-5f0e-4b8c-9a39-4f1e2b7c6${String(n).padStart(3, '0')}`;
  const signIn = async (n: number) => {
    f.advance(day / 2);
    const { login, verifier } = await f.start('ada@lab.org', { installId: install(n), ip: null });
    return await f.verify(login, verifier);
  };
  const first = await signIn(1);
  const again = await signIn(1);
  const keys = async () => await f.scope.userKeys.keys(await f.human());
  const live = async () => (await keys()).filter((key) => key.revokedAt === null);
  assert.deepEqual(
    (await live()).map((key) => key.id),
    [again.key.id],
    'the same install replaces its key',
  );
  await assert.rejects(f.principal(first.token), { code: 'unauthorized' });
  for (let n = 2; n <= 10; n++) await signIn(n);
  assert.equal((await live()).length, 10);
  await assert.rejects(signIn(11), { code: 'agent_key_limit', status: 409 });
  // The limit counts other installs: the same install can still sign in again.
  const replaced = await signIn(10);
  assert.equal((await live()).length, 10);
  const key = (await keys()).find((value) => value.id === replaced.key.id)!;
  assert.equal(key.label, 'Claude Code on ada-mbp');
  assert.equal(key.grantScope, 'account');
  assert.equal(key.via, 'email_code', 'the Keys page tells agent sign-ins apart');
  const events = await f.state.read((sql) =>
    sql.all<{ data_json: string }>(
      "SELECT data_json FROM events WHERE type='actor.key_created' AND subject_id=?",
      replaced.key.id,
    ),
  );
  const data = JSON.parse(events[0]!.data_json);
  assert.deepEqual(data, {
    grantScope: 'account',
    label: 'Claude Code on ada-mbp',
    expiresAt: replaced.key.expiresAt,
    via: 'email_code',
  });
  assert.equal(Date.parse(replaced.key.expiresAt) - Date.parse(key.createdAt), 90 * day);
  f.advance(89 * day);
  assert.ok(await f.scope.caller(await f.principal(replaced.token), f.project.id));
  f.advance(2 * day);
  await assert.rejects(f.principal(replaced.token), { code: 'unauthorized' });
  const after = (await keys()).find((value) => value.id === replaced.key.id)!;
  assert.equal(after.expiresAt, key.expiresAt, 'never renewed');
});

/** POSTs JSON to the server, from `ip` through the local proxy when given. */
async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    redirect: 'error',
  });
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    body: (await response.json()) as any,
  };
}
const startBody = (
  email: string,
  verifier: string,
  installId = '9d5c3a1e-5f0e-4b8c-9a39-4f1e2b7c6d01',
) => ({
  email,
  client: { name: 'Codex', host: 'ada-mbp', installId },
  verifierHash: verifierHash(verifier),
});

test('/connect serves the agent page, an installer that pins the connector, and the connector', async (t) => {
  const f = await connectServer({ serverName: 'merv-staging' });
  t.after(() => f.close());
  const hostDir = new URL(f.url).host.replace(':', '_');
  const page = await fetch(`${f.url}/connect`);
  assert.equal(page.headers.get('content-type'), 'text/plain; charset=utf-8');
  const text = await page.text();
  assert.ok(text.includes(`curl -fsSL ${f.url}/connect/install.sh | sh`));
  assert.ok(text.includes(`~/.merv/connect/${hostDir}/bin/merv-connect login`));
  assert.ok(text.includes('"merv-staging"') && !text.includes('__MERV'));
  const connector = await (await fetch(`${f.url}/connect/merv-connect.mjs`)).text();
  assert.ok(connector.includes(f.url) && !connector.includes('__MERV'));
  const installer = await (await fetch(`${f.url}/connect/install.sh`)).text();
  assert.ok(installer.includes(`SHA='${createHash('sha256').update(connector).digest('hex')}'`));
  assert.ok(installer.includes(`ORIGIN='${f.url}'`) && installer.trimEnd().endsWith('main "$@"'));
  assert.equal((await fetch(`${f.url}/connect/other`)).status, 404);
});

test('a start answers the same for every address; the code arrives only for an eligible account', async (t) => {
  const f = await connectServer();
  t.after(() => f.close());
  const known = await post(`${f.url}/connect/login`, startBody('ada@lab.org', 'a'.repeat(43)));
  const unknown = await post(`${f.url}/connect/login`, startBody('nobody@lab.org', 'b'.repeat(43)));
  for (const answer of [known, unknown]) {
    assert.equal(answer.status, 202);
    assert.deepEqual(Object.keys(answer.body).sort(), [
      'expiresAt',
      'loginId',
      'phrase',
      'retryAfterSeconds',
    ]);
  }
  const code = await f.codeFor('ada@lab.org');
  assert.match(code!, /^\d{4}-\d{4}$/);
  assert.equal(f.mails.length, 1);
  const mail = f.mails[0]!;
  assert.equal(mail.to, 'Ada@Lab.org');
  assert.ok(mail.text.includes(`Request: ${known.body.phrase}`));
  assert.ok(mail.text.includes('Signs in: Codex on ada-mbp'));
  assert.equal(mail.idempotencyKey, `agent-login/${known.body.loginId}`);
  // Every refusal of the challenge reads alike.
  const wrong = await post(`${f.url}/connect/login/${known.body.loginId}/verify`, {
    code: code === '0000-0000' ? '0000-0001' : '0000-0000',
    verifier: 'a'.repeat(43),
  });
  const malformed = await post(`${f.url}/connect/login/nope/verify`, {
    code: 'x',
    verifier: 'a'.repeat(43),
  });
  assert.deepEqual(wrong, malformed);
  assert.equal(wrong.status, 400);
  assert.deepEqual(wrong.body, {
    error: {
      code: 'invalid_code',
      message: 'That code does not match this sign-in. Check it, or run login again.',
    },
  });
  const signedIn = await post(`${f.url}/connect/login/${known.body.loginId}/verify`, {
    code: code!.replace('-', ' - '),
    verifier: 'a'.repeat(43),
  });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.body.email, 'Ada@Lab.org');
  assert.deepEqual(signedIn.body.projects, [
    { id: f.ada.project!.id, name: 'Grokking', role: 'operator' },
  ]);
  assert.equal(signedIn.body.key.label, 'Codex on ada-mbp');
  const notice = f.mails.at(-1)!;
  assert.equal(notice.subject, 'New Merv agent sign-in: Codex on ada-mbp');
  assert.ok(notice.text.includes(`${f.url}/ui/settings/keys`));
  assert.ok(!JSON.stringify(f.mails).includes(signedIn.body.token));
  // The key works over MCP with no project, and lists the person's projects.
  const listed = await post(
    `${f.url}/mcp`,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'project.list', arguments: {} },
    },
    {
      authorization: `Bearer ${signedIn.body.token}`,
      accept: 'application/json, text/event-stream',
    },
  );
  assert.equal(listed.status, 200);
  assert.equal(JSON.parse(listed.body.result.content[0].text).projects[0].role, 'operator');
  // Signed in to Merv once but in no project: the same answer, and no email at all.
  await f.person('44444444-4444-4444-8444-444444444444', 'cy@lab.org');
  const sent = f.mails.length;
  const cy = await post(`${f.url}/connect/login`, startBody('Cy@Lab.org', 'c'.repeat(43)));
  assert.equal(cy.status, 202);
  await f.drain();
  assert.equal(f.mails.length, sent);
});

test('an email is looked up in lower case, and a client label is plain words', async () => {
  const body = (client: Record<string, string>) => ({
    email: ' Ada@Lab.ORG ',
    client: { installId: '9d5c3a1e-5f0e-4b8c-9a39-4f1e2b7c6d01', ...client },
    verifierHash: 'a'.repeat(43),
  });
  assert.equal(
    startInput.parse(body({ name: 'Claude Code', host: 'ada-mbp' })).email,
    'ada@lab.org',
  );
  assert.ok(startInput.safeParse(body({ name: 'Visual Studio Code', host: 'Ada_MBP-2' })).success);
  // Nothing a mail client would link, reorder or hide: these become the code email's "Signs in".
  for (const [name, host] of [
    ['Claude Code', '\u202Eurgent: verify at https://merv-verify.example/c'],
    ['Claude Code', 'merv-verify.example'],
    ['https://merv-verify.example', 'ada-mbp'],
    ['Merv: urgent', 'ada-mbp'],
    ['Claude\u200bCode', 'ada-mbp'],
    ['Claude  Code', 'ada-mbp'],
    ['Claude Code', 'ada mbp'],
  ])
    assert.equal(startInput.safeParse(body({ name, host })).success, false, `${name} / ${host}`);
});

test('X-Forwarded-For is believed only from the proxy ranges a deployment names', () => {
  const request = (remoteAddress: string) =>
    ({
      socket: { remoteAddress },
      headers: { 'x-forwarded-for': '10.9.9.9, 198.51.100.7' },
    }) as never;
  // Host Caddy reaches a published Docker port from the bridge gateway, which production names
  // alone: another container on the bridge cannot forge its address.
  const bridge = proxyList(['127.0.0.1/32', '::1/128', '172.18.0.1/32']);
  assert.equal(clientIp(request('172.18.0.1'), bridge), '198.51.100.7');
  assert.equal(clientIp(request('::ffff:172.18.0.1'), bridge), '198.51.100.7');
  assert.equal(clientIp(request('127.0.0.1'), bridge), '198.51.100.7');
  assert.equal(clientIp(request('172.18.0.5'), bridge), '172.18.0.5');
  assert.equal(clientIp(request('203.0.113.9'), bridge), '203.0.113.9');
  // Loopback only, unless configured.
  assert.equal(clientIp(request('172.18.0.1')), '172.18.0.1');
  const config = {
    apiKeyEnv: 'RESEND_API_KEY',
    from: 'Merv <login@example.com>',
    publicOrigin: 'https://merv.example/',
  };
  assert.deepEqual(agentLoginSchema.parse(config).trustedProxies, ['127.0.0.1/32', '::1/128']);
  for (const range of ['172.16.0.0', '172.16.0.0/33', 'fd00::/129', 'proxy/8', '10.0.0.0/8/1'])
    assert.equal(
      agentLoginSchema.safeParse({ ...config, trustedProxies: [range] }).success,
      false,
      range,
    );
});

test('limits answer 429 with Retry-After, and an address is trusted only from the local proxy', async (t) => {
  const f = await connectServer({ limits: { ipPerHour: 2, verifyPerIpMinute: 2 } });
  t.after(() => f.close());
  const from = (ip: string) => ({ 'x-forwarded-for': `10.0.0.1, ${ip}` });
  for (const n of [1, 2])
    assert.equal(
      (
        await post(
          `${f.url}/connect/login`,
          startBody(`p${n}@lab.org`, 'a'.repeat(43)),
          from('198.51.100.1'),
        )
      ).status,
      202,
    );
  const limited = await post(
    `${f.url}/connect/login`,
    startBody('p3@lab.org', 'a'.repeat(43)),
    from('198.51.100.1'),
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAfter, '3600');
  assert.equal(limited.body.error.code, 'login_rate_limited');
  // Another forwarded address is another bucket, since this socket is the loopback proxy.
  assert.equal(
    (
      await post(
        `${f.url}/connect/login`,
        startBody('p4@lab.org', 'a'.repeat(43)),
        from('198.51.100.2'),
      )
    ).status,
    202,
  );
  // From any other socket, X-Forwarded-For is ignored.
  const request = (remoteAddress: string) =>
    ({ socket: { remoteAddress }, headers: { 'x-forwarded-for': '198.51.100.7' } }) as never;
  assert.equal(clientIp(request('203.0.113.9')), '203.0.113.9');
  assert.equal(clientIp(request('::1')), '198.51.100.7');
  const verify = () =>
    post(`${f.url}/connect/login/login_x/verify`, { code: '00000000', verifier: 'a'.repeat(43) });
  assert.equal((await verify()).status, 400);
  assert.equal((await verify()).status, 400);
  const tooMany = await verify();
  assert.equal(tooMany.status, 429);
  assert.equal(tooMany.retryAfter, '60');
  await f.drain();
});

/** A random address in an IPv6 /64. */
const in64 = (prefix: string) =>
  `${prefix}:${Array.from({ length: 4 }, () => randomBytes(2).toString('hex')).join(':')}`;
const randomGroup = () => randomBytes(2).toString('hex');
const randomPrefix = () => Array.from({ length: 4 }, randomGroup).join(':');

test('an IPv6 client counts by its /64, an IPv4 one by its address', () => {
  for (const [ip, bucket] of [
    ['2001:db8:1:2:aaaa::1', '2001:db8:1:2::/64'],
    ['2001:DB8:1:2::', '2001:db8:1:2::/64'],
    ['2001:db8::1:2:3:4:5', '2001:db8:0:1::/64'],
    ['2001:0db8:0001:0002:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    ['fe80::1%en0', 'fe80:0:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['198.51.100.7', '198.51.100.7'],
  ])
    assert.equal(addressBucket(ip), bucket, ip);
  // A mapped IPv4 address is that address, from the socket or from a trusted proxy.
  const request = (remoteAddress: string, forwarded?: string) =>
    ({
      socket: { remoteAddress },
      headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
    }) as never;
  assert.equal(clientIp(request('::ffff:203.0.113.9')), '203.0.113.9');
  assert.equal(clientIp(request('127.0.0.1', '::FFFF:198.51.100.7')), '198.51.100.7');
});

test('verify admission holds each /64 and each /48, with no cap on all callers', () => {
  let now = 0;
  const tally = (gate: Admission, ips: string[]) => {
    const seen: Record<string, number> = {};
    for (const ip of ips) {
      let outcome = 'admitted';
      try {
        gate.admit(ip);
      } catch (error) {
        outcome = (error as MervError).code;
      }
      seen[outcome] = (seen[outcome] ?? 0) + 1;
    }
    return seen;
  };
  const gate = new Admission(5, 20, () => now);
  // Rotating through one /64 is one caller.
  const one = Array.from({ length: 20_000 }, () => in64('2001:db8:aa:bb'));
  assert.deepEqual(tally(gate, one), { admitted: 5, login_rate_limited: 19_995 });
  assert.equal(gate.size, 2);
  // A fresh /64 for every request inside one /48 is held by the /48.
  const site = Array.from({ length: 20_000 }, () => in64(`2001:db8:cc:${randomGroup()}`));
  assert.deepEqual(tally(gate, site), { admitted: 20, login_rate_limited: 19_980 });
  assert.equal(gate.size, 23);
  // A fresh /48 for every request is admitted: no cap on all callers to exhaust.
  const many = Array.from({ length: 20_000 }, () => in64(randomPrefix()));
  assert.deepEqual(tally(gate, many), { admitted: 20_000 });
  // The next window starts empty.
  now += 60_000;
  assert.deepEqual(tally(gate, ['198.51.100.7']), { admitted: 1 });
  assert.equal(gate.size, 2);
  // At the ceiling on buckets, only a new bucket is refused.
  const full = new Admission(5, 20, () => now, 10);
  const known = ['198.51.100.7', '2001:db8:dd:1::1'];
  const fill = [...known, ...Array.from({ length: 3 }, () => in64(randomPrefix()))];
  assert.deepEqual(tally(full, fill), { admitted: 5 });
  assert.equal(full.size, 10);
  const fresh = [in64(randomPrefix()), '198.51.100.8', in64('2001:db8:dd:2')];
  assert.deepEqual(tally(full, fresh), { login_rate_limited: 3 });
  assert.deepEqual(tally(full, [...known, ...known]), { admitted: 4 });
  assert.equal(full.size, 10);
});

test('rotating IPv6 addresses and random login ids cost one bounded lookup each, at most', async (t) => {
  const f = await connectServer({ limits: { verifyPerIpMinute: 3, verifyPerNetworkMinute: 10 } });
  t.after(() => f.close());
  // Every store read the verify route makes.
  let lookups = 0;
  const read = f.state.read.bind(f.state);
  f.state.read = (...args) => {
    lookups++;
    return read(...args);
  };
  const from = (ip: string) => ({ 'x-forwarded-for': ip });
  const started = await post(
    `${f.url}/connect/login`,
    startBody('ada@lab.org', 'a'.repeat(43)),
    from('198.51.100.9'),
  );
  const code = (await f.codeFor('ada@lab.org'))!;
  lookups = 0;
  const guess = (ip: string) =>
    post(
      `${f.url}/connect/login/login_${randomBytes(16).toString('base64url')}/verify`,
      { code: '00000000', verifier: 'b'.repeat(43) },
      from(ip),
    );
  const statuses = async (ips: string[]) => {
    const seen: Record<string, number> = {};
    for (const ip of ips) {
      const answer = await guess(ip);
      const key = answer.body.error.code;
      seen[key] = (seen[key] ?? 0) + 1;
      if (answer.status === 429)
        assert.match(answer.body.error.message, /too many sign-in attempts/i);
    }
    return seen;
  };
  const one = Array.from({ length: 150 }, () => in64('2001:db8:aa:bb'));
  assert.deepEqual(await statuses(one), { invalid_code: 3, login_rate_limited: 147 });
  assert.equal(lookups, 3);
  // A fresh /64 each time inside the same /48 is held by the /48.
  const site = Array.from({ length: 50 }, () => in64(`2001:db8:aa:${randomGroup()}`));
  assert.deepEqual(await statuses(site), { invalid_code: 7, login_rate_limited: 43 });
  assert.equal(lookups, 10);
  // A fresh /48 each time is admitted, one lookup each, and spends no one else's attempts.
  const many = Array.from({ length: 100 }, () => in64(randomPrefix()));
  assert.deepEqual(await statuses(many), { invalid_code: 100 });
  assert.equal(lookups, 110);
  // The person's own verify, from their own address, still passes.
  const signedIn = await post(
    `${f.url}/connect/login/${started.body.loginId}/verify`,
    { code, verifier: 'a'.repeat(43) },
    from('198.51.100.9'),
  );
  assert.equal(signedIn.status, 200);
  // A malformed id is refused as a wrong code is, without a lookup.
  lookups = 0;
  const malformed = await post(
    `${f.url}/connect/login/login_x/verify`,
    { code: '00000000', verifier: 'a'.repeat(43) },
    from('198.51.100.10'),
  );
  assert.equal(malformed.body.error.code, 'invalid_code');
  assert.equal(lookups, 0);
});

test('a full delivery queue refuses new starts with login_capacity', async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const f = await connectServer({
    limits: { queueConcurrency: 1, queueWaiting: 1 },
    mailer: () => held,
  });
  t.after(async () => {
    release();
    await f.close();
  });
  const start = (n: number) =>
    post(`${f.url}/connect/login`, startBody('ada@lab.org', 'a'.repeat(43)), {
      'x-forwarded-for': `198.51.100.${n}`,
    });
  assert.equal((await start(1)).status, 202);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await start(2)).status, 202);
  const full = await start(3);
  assert.equal(full.status, 429);
  assert.equal(full.body.error.code, 'login_capacity');
});

// Its refusal at every credential handler is pinned in credential-lock.test.ts.
test('an email-code key cannot manage members or invitations', async (t) => {
  const f = await connectServer();
  t.after(() => f.close());
  const other = await f.person('22222222-2222-4222-8222-222222222222', 'bob@lab.org', 'Bob');
  const started = await post(`${f.url}/connect/login`, startBody('ada@lab.org', 'a'.repeat(43)));
  const signedIn = await post(`${f.url}/connect/login/${started.body.loginId}/verify`, {
    code: await f.codeFor('ada@lab.org'),
    verifier: 'a'.repeat(43),
  });
  const token = signedIn.body.token as string;
  const projectId = f.ada.project!.id;
  const as = async (path: string, method: string, body?: unknown) => {
    const response = await fetch(`${f.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-merv-project-id': projectId,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return response.status;
  };
  assert.equal(
    await as(`/projects/${projectId}/members/${other.human.user.subject}`, 'PATCH', {
      role: 'reader',
    }),
    403,
  );
  assert.equal(
    await as(`/projects/${projectId}/members/${other.human.user.subject}`, 'DELETE'),
    403,
  );
  assert.equal(
    await as(`/projects/${projectId}/invitations`, 'POST', {
      email: 'bob@lab.org',
      role: 'reader',
    }),
    403,
  );
});

test('scope-api turns agent sign-in on only with the directory admin API and a mail key', async (t) => {
  const ctx = new Context();
  const mounted: string[] = [];
  ctx.provide('scope', {} as never);
  ctx.provide('api', {
    mount: (prefix: string) => (mounted.push(prefix), () => undefined),
  } as never);
  ctx.provide('identity', { findUserByEmail: async () => null } as never);
  t.after(() => ctx.fiber.dispose());
  const config = {
    agentLogin: {
      apiKeyEnv: 'MERV_AGENT_LOGIN_TEST_KEY',
      from: 'Merv <login@example.com>',
      publicOrigin: 'https://merv.example',
    },
  };
  await assert.rejects(
    async () => await ctx.plugin(scopeApiPlugin, config as never),
    /directoryAdmin|agent_login_unavailable|unavailable/,
  );
  assert.ok(!mounted.includes('/connect'));
});
