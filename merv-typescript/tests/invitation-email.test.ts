import test from 'node:test';
import assert from 'node:assert/strict';
import { ResendInvitationSender } from '@merv/scope/invitation-email';
import { SupabaseIdentity } from '@merv/identity';
import type { ProjectInvitation } from '@merv/contracts';

const offer: ProjectInvitation = {
  id: 'invite_test',
  projectId: 'project_test',
  projectName: 'Research <script>alert(1)</script>',
  issuer: 'https://auth.example/auth/v1',
  subject: '11111111-1111-4111-8111-111111111111',
  email: 'person@example.com',
  role: 'producer',
  status: 'pending',
  createdAt: '2026-10-14T12:00:00.000Z',
  expiresAt: '2026-10-21T12:00:00.000Z',
  sentAt: null,
};

test('Resend email has one review action, escaped project text, and stable idempotency on retries', async () => {
  process.env.MERV_TEST_INVITATION_MAIL_KEY = 'synthetic-key';
  try {
    const calls: RequestInit[] = [];
    const sender = new ResendInvitationSender(
      {
        apiKeyEnv: 'MERV_TEST_INVITATION_MAIL_KEY',
        from: 'Merv <invites@example.com>',
        publicOrigin: 'https://merv.example',
      },
      async (url, init) => {
        assert.equal(url, 'https://api.resend.com/emails');
        calls.push(init!);
        return new Response(JSON.stringify({ id: 'email_test' }));
      },
    );
    await sender.send(offer);
    await sender.send(offer);
    assert.equal(calls[0]!.body, calls[1]!.body);
    assert.equal(
      (calls[0]!.headers as Record<string, string>)['idempotency-key'],
      'project-invitation/invite_test',
    );
    const body = JSON.parse(calls[0]!.body as string);
    assert.deepEqual(body.to, ['person@example.com']);
    assert.equal((body.html.match(/<a /g) ?? []).length, 1);
    assert.ok(body.html.includes('Review invitation'));
    assert.ok(body.html.includes('&lt;script&gt;'));
    assert.ok(!body.html.includes('<script>'));
    assert.ok(!body.html.includes('synthetic-key'));
    assert.ok(!body.text.includes('Join only if you accept'));
    assert.ok(!body.html.includes('Join only if you accept'));
    assert.ok(!body.text.includes('Merv invitation preview'));
    assert.ok(!body.subject.includes('[Preview]'));
    assert.ok(body.text.includes(offer.projectName));
    const fail = new ResendInvitationSender(
      {
        apiKeyEnv: 'MERV_TEST_INVITATION_MAIL_KEY',
        from: 'Merv <invites@example.com>',
        publicOrigin: 'https://merv.example',
      },
      async () => new Response('private upstream detail', { status: 500 }),
    );
    await assert.rejects(() => fail.send(offer), { code: 'invitation_email_failed' });
  } finally {
    delete process.env.MERV_TEST_INVITATION_MAIL_KEY;
  }
});

test('Supabase lookup uses the existing exact-email RPC, keeps the service key private, and rejects malformed identities', async () => {
  process.env.MERV_TEST_DIRECTORY_SECRET = 'synthetic-directory-key';
  process.env.MERV_TEST_DIRECTORY_JWT = 'synthetic-jwt-key-longer-than-thirty-two-bytes';
  try {
    let rows: unknown = [{ id: offer.subject }];
    const identity = new SupabaseIdentity(
      {
        supabaseUrl: 'https://auth.example',
        mode: 'hs256',
        secretEnv: 'MERV_TEST_DIRECTORY_JWT',
        directoryKeyEnv: 'MERV_TEST_DIRECTORY_SECRET',
      },
      {
        fetch: async (url, init) => {
          assert.equal(url, 'https://auth.example/rest/v1/rpc/lookup_user_for_share');
          assert.deepEqual(JSON.parse(init!.body as string), {
            target_email: 'person@example.com',
          });
          assert.equal((init!.headers as Record<string, string>).apikey, 'synthetic-directory-key');
          return new Response(JSON.stringify(rows));
        },
      },
    );
    assert.deepEqual(await identity.findUserByEmail('person@example.com'), {
      issuer: offer.issuer,
      subject: offer.subject,
    });
    assert.deepEqual(identity.configuration(), { enabled: true });
    rows = [];
    assert.equal(await identity.findUserByEmail('person@example.com'), null);
    rows = [{ id: offer.subject, is_anonymous: true }];
    assert.equal(await identity.findUserByEmail('person@example.com'), null);
    for (const value of [
      [{ id: 'not-a-user-id' }],
      [{ id: offer.subject }, { id: offer.subject }],
      {},
    ]) {
      rows = value;
      await assert.rejects(() => identity.findUserByEmail('person@example.com'), {
        code: 'directory_unavailable',
      });
    }
  } finally {
    delete process.env.MERV_TEST_DIRECTORY_SECRET;
    delete process.env.MERV_TEST_DIRECTORY_JWT;
  }
});
