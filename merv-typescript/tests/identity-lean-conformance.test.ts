import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CredentialStore, tokenDigest } from '@merv/identity/credentials';
import { openState } from './fixtures/state.js';

type Input = {
  owner: number;
  subject: number;
  credentialKind: number;
  expires: number | null;
  deadline: number | null;
};
type Command =
  | ({ kind: 'issue' | 'adopt'; id: number } & Input)
  | { kind: 'renew'; id: number; owner: number; expires: number }
  | { kind: 'revoke'; id: number; owner: number }
  | { kind: 'revokeSubject'; owner: number; subject: number; credentialKind: number }
  | { kind: 'authenticate'; id: number; kinds: number[] }
  | { kind: 'advance'; time: number };
type Row = Input & { id: number; created: number; revoked: number | null };
type Observation = { outcome: string; rows: Row[] };
const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../verification/lean');
const binary =
  process.env.MERV_IDENTITY_LEAN_BINARY ??
  resolve(directory, '.lake/build/bin/identity_credentials_model');
const available = existsSync(binary);
const options = {
  skip:
    !available && process.env.MERV_REQUIRE_LEAN !== '1'
      ? 'Build identity_credentials_model'
      : undefined,
};
const origin = Date.parse('2026-09-26T00:00:00.000Z');
const iso = (time: number | null) => (time === null ? null : new Date(origin + time).toISOString());
const offset = (time: string | null) => (time === null ? null : Date.parse(time) - origin);
const token = (id: number) => `lean_identity_token_${id.toString().padStart(8, '0')}`;
const identifier = (id: number) => `v${id}`;
const decode = (id: string) => Number(id.slice(1));

function model(commands: Command[]): Observation[] {
  assert.ok(available, `Required Lean model missing: ${binary}`);
  const result = spawnSync(binary, [], {
    cwd: directory,
    encoding: 'utf8',
    input: JSON.stringify({ commands }),
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).observations as Observation[];
}

async function implementation(
  commands: Command[],
  mutation?: 'wrong-owner' | 'expired-renewal',
): Promise<Observation[]> {
  const state = await openState();
  let now = 0;
  const store = new CredentialStore(state, () => origin + now);
  await store.initialize();
  const ids = [...new Set(commands.flatMap((c) => ('id' in c ? [c.id] : [])))].sort(
    (a, b) => a - b,
  );
  const hashes = new Map(ids.map((id) => [tokenDigest(token(id)), id]));
  const output: Observation[] = [];
  try {
    for (const command of commands) {
      let outcome = 'ok';
      try {
        switch (command.kind) {
          case 'advance':
            now = command.time;
            break;
          case 'issue':
          case 'adopt': {
            const input = {
              owner: identifier(command.owner),
              subject: identifier(command.subject),
              kind: identifier(command.credentialKind),
              expiresAt: iso(command.expires),
              hardDeadline: iso(command.deadline),
            };
            if (command.kind === 'issue') await store.issue({ ...input, token: token(command.id) });
            else await store.adopt({ ...input, tokenHash: tokenDigest(token(command.id)) });
            break;
          }
          case 'renew': {
            // Deliberately faulty adapter: make an expired row appear live to the real store.
            const actual = now;
            if (mutation === 'expired-renewal') now = 0;
            try {
              await store.renew(
                tokenDigest(token(command.id)),
                identifier(command.owner),
                iso(command.expires)!,
              );
            } finally {
              now = actual;
            }
            break;
          }
          case 'revoke': {
            const owner = mutation === 'wrong-owner' ? 1 : command.owner;
            const result = await store.revoke(tokenDigest(token(command.id)), identifier(owner));
            if (!result) outcome = 'missing';
            break;
          }
          case 'revokeSubject':
            await store.revokeSubject(
              identifier(command.owner),
              identifier(command.subject),
              identifier(command.credentialKind),
            );
            break;
          case 'authenticate':
            await store.authenticate(token(command.id), command.kinds.map(identifier));
            break;
        }
      } catch (error) {
        assert.equal(typeof (error as { code?: string }).code, 'string', String(error));
        outcome = (error as { code: string }).code;
      }
      const rows = await state.read((sql) =>
        sql.all<{
          token_hash: string;
          owner: string;
          subject: string;
          kind: string;
          created_at: string;
          expires_at: string | null;
          hard_deadline: string | null;
          revoked_at: string | null;
        }>('SELECT * FROM identity_credentials'),
      );
      output.push({
        outcome,
        rows: rows
          .map((r) => ({
            id: hashes.get(r.token_hash)!,
            owner: decode(r.owner),
            subject: decode(r.subject),
            credentialKind: decode(r.kind),
            created: offset(r.created_at)!,
            expires: offset(r.expires_at),
            deadline: offset(r.hard_deadline),
            revoked: offset(r.revoked_at),
          }))
          .sort((a, b) => a.id - b.id),
      });
    }
    return output;
  } finally {
    await state.close();
  }
}

const base: Input = { owner: 1, subject: 1, credentialKind: 1, expires: 50, deadline: 100 };
const targeted: Command[] = [
  { kind: 'revoke', id: 99, owner: 1 },
  { kind: 'issue', id: 99, ...base }, // Unknown revocation leaves no tombstone.
  { kind: 'issue', id: 1, ...base },
  { kind: 'issue', id: 1, ...base },
  { kind: 'authenticate', id: 1, kinds: [2] },
  { kind: 'authenticate', id: 1, kinds: [2, 1] },
  { kind: 'revoke', id: 1, owner: 2 },
  { kind: 'renew', id: 1, owner: 2, expires: 75 },
  { kind: 'renew', id: 1, owner: 1, expires: 25 },
  { kind: 'renew', id: 1, owner: 1, expires: 101 },
  { kind: 'renew', id: 1, owner: 1, expires: 75 },
  { kind: 'adopt', id: 1, ...base, expires: 90, deadline: 120 },
  { kind: 'adopt', id: 1, ...base, owner: 2 },
  { kind: 'adopt', id: 1, ...base, subject: 2 },
  { kind: 'adopt', id: 1, ...base, credentialKind: 2 },
  { kind: 'advance', time: 75 },
  { kind: 'renew', id: 1, owner: 1, expires: 100 },
  { kind: 'authenticate', id: 1, kinds: [1] },
  { kind: 'adopt', id: 1, ...base, expires: 100 },
  { kind: 'advance', time: 74 }, // Backward clocks can restore expiry validity, not revocation.
  { kind: 'authenticate', id: 1, kinds: [1] },
  { kind: 'revoke', id: 1, owner: 1 },
  { kind: 'advance', time: 76 },
  { kind: 'revoke', id: 1, owner: 1 },
  { kind: 'adopt', id: 1, ...base },
  { kind: 'renew', id: 1, owner: 1, expires: 100 },
  { kind: 'advance', time: 0 },
  { kind: 'authenticate', id: 1, kinds: [1] },
  { kind: 'issue', id: 2, ...base, expires: null, deadline: null },
  { kind: 'renew', id: 2, owner: 1, expires: 90 },
  { kind: 'issue', id: 3, ...base, subject: 2 },
  { kind: 'issue', id: 4, ...base, credentialKind: 2 },
  { kind: 'issue', id: 5, ...base, owner: 2 },
  { kind: 'issue', id: 6, ...base, expires: null },
  { kind: 'issue', id: 7, ...base, expires: 101 },
  { kind: 'adopt', id: 8, ...base, expires: 0 }, // Adoption accepts expired history.
  { kind: 'issue', id: 9, ...base, expires: 0 },
  { kind: 'revokeSubject', owner: 1, subject: 1, credentialKind: 1 },
  ...[2, 3, 4, 5, 8, 99].map((id) => ({ kind: 'authenticate' as const, id, kinds: [1, 2] })),
  { kind: 'advance', time: 100 },
  { kind: 'authenticate', id: 3, kinds: [1] },
];

function generated(seed: number): Command[] {
  let state = seed;
  const random = (n: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
  const commands: Command[] = [];
  for (let i = 0; i < 90; i++) {
    const id = random(9),
      owner = random(3),
      subject = random(3),
      credentialKind = random(3);
    const expires = random(4) === 0 ? null : random(140);
    const deadline = random(3) === 0 ? null : random(160);
    switch (random(7)) {
      case 0:
        commands.push({ kind: 'issue', id, owner, subject, credentialKind, expires, deadline });
        break;
      case 1:
        commands.push({ kind: 'adopt', id, owner, subject, credentialKind, expires, deadline });
        break;
      case 2:
        commands.push({ kind: 'renew', id, owner, expires: random(160) });
        break;
      case 3:
        commands.push({ kind: 'revoke', id, owner });
        break;
      case 4:
        commands.push({ kind: 'revokeSubject', owner, subject, credentialKind });
        break;
      case 5:
        commands.push({ kind: 'authenticate', id, kinds: [credentialKind] });
        break;
      case 6:
        commands.push({ kind: 'advance', time: random(130) });
        break;
    }
  }
  return commands;
}

test(
  'compiled Lean ledger agrees with real CredentialStore records after every lifecycle command',
  options,
  async () => {
    for (const commands of [targeted, generated(42), generated(20260929), generated(0xdecaf)]) {
      const expected = model(commands);
      assert.deepEqual(await implementation(commands), expected, JSON.stringify(commands));
    }
  },
);

test(
  'ledger differential harness rejects owner-bypass and expired-renewal negative controls',
  options,
  async () => {
    const ownerTrace: Command[] = [
      { kind: 'issue', id: 1, ...base },
      { kind: 'revoke', id: 1, owner: 2 },
      { kind: 'authenticate', id: 1, kinds: [1] },
    ];
    const expiredTrace: Command[] = [
      { kind: 'issue', id: 1, ...base },
      { kind: 'advance', time: 50 },
      { kind: 'renew', id: 1, owner: 1, expires: 80 },
    ];
    for (const [commands, mutation] of [
      [ownerTrace, 'wrong-owner'],
      [expiredTrace, 'expired-renewal'],
    ] as const) {
      const expected = model(commands);
      const actual = await implementation(commands, mutation);
      assert.throws(
        () => assert.deepEqual(actual, expected),
        assert.AssertionError,
        `negative control ${mutation} was not detected`,
      );
    }
  },
);
