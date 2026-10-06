import test from 'node:test';
import assert from 'node:assert/strict';
import { isDirectHuman, requireHuman, type Caller } from '@merv/contracts';

const person: Caller = {
  actorId: 'actor-1',
  projectId: 'project-1',
  human: {
    issuer: 'issuer',
    subject: 'subject',
    expiresAt: '2099-01-01T00:00:00.000Z',
    membershipId: 'm',
  },
};

test('only the person themself, signed in, is a direct human', () => {
  assert.equal(isDirectHuman(person), true);
  assert.doesNotThrow(() => requireHuman(person, 'human_required', 'Sign in'));
  const others: Partial<Caller>[] = [
    { human: undefined },
    { credentialId: 'credential-1' },
    { key: { id: 'key-1', membershipId: 'm' } },
    { session: { id: 'session-1' } },
    { managed: { allocationId: 'allocation-1', epoch: 1, credentialHash: 'hash' } },
    { conversation: { id: 'conversation-1', epoch: 1, commandId: 'command-1', runtimeId: 'r' } },
    {
      service: {
        vouchedBy: {
          kind: 'actor',
          actorId: 'a',
          projectId: 'p',
          credentialId: 'c',
          expiresAt: null,
        },
      },
    },
  ];
  for (const other of others) {
    const caller = { ...person, ...other };
    assert.equal(isDirectHuman(caller), false, JSON.stringify(other));
    assert.throws(() => requireHuman(caller, 'human_required', 'Sign in'), {
      code: 'human_required',
      status: 403,
      message: 'Sign in',
    });
  }
});
