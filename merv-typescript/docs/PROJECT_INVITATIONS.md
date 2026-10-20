# Project invitations

Settings → Members → Invite member sends an email through Resend. The backend resolves the email to an existing Supabase account through the shared `lookup_user_for_share` RPC. Accounts that do not exist must sign up first; this flow does not create Supabase users or send Supabase authentication invitations.

Invitations create no actor, project membership, project visibility or usage allowance. The invited person signs in and explicitly accepts or declines on the project chooser. An invitation link is only a navigation hint, never a bearer credential. The matching Supabase issuer and subject are required even with the link. Invitations expire after seven days. Operators can revoke them; retiring the inviter's operator membership also withdraws their pending invitations. Acceptance is atomic, retryable and audited, and never revives a removed membership on replay.

The HTTP account-ID add-member path now returns `invitation_required`. Internal provisioning and migration helpers remain available. Existing memberships and role changes are unchanged.

## Configuration

The `identity` plugin needs `directoryKeyEnv: "SUPABASE_SERVICE_KEY"`. The `scope-api` plugin needs:

```json
{
  "invitations": {
    "apiKeyEnv": "RESEND_API_KEY",
    "from": "Merv <invites@rapidreview.io>",
    "publicOrigin": "https://experiments.rapidreview.io"
  }
}
```

For the hosted config renderer, set `MERV_PROJECT_INVITATIONS=true`, `SUPABASE_SERVICE_KEY`, and `RESEND_API_KEY` in managed server environment storage. `MERV_INVITATION_FROM` overrides the sender. To reuse the existing Merv sending key, set `MERV_INVITATION_RESEND_KEY_ENV=MERV_CUSTOMER_RESEND_KEY` instead of adding `RESEND_API_KEY`. The Resend key should have sending access limited to the verified domain. The service key must be able to invoke the existing Supabase directory RPC. Neither key is returned to browsers or logged. Keep the feature disabled until credentials are ready. The environment example leaves it disabled.

Email delivery runs outside database transactions. The invitation is persisted first; a failure leaves it pending with an explicit error and a Retry email action in Members. Retries use the invitation ID as Resend's idempotency key and a stable message. Resend retains idempotency keys for 24 hours; a retry after that window may deliver another email pointing at the same invitation. A confirmed send is not repeated. Provider acceptance of the email does not guarantee inbox delivery; delivery webhooks are not part of this change.

No actual invitation is sent by tests. Tests use a fake Supabase RPC and fake Resend responses.

## Agent sign-in

`/connect` lets a person's own agent sign a machine in by an emailed code (`packages/scope/src/connect.ts`, `agent-logins.ts`). It reuses the directory lookup and the Resend sender, and additionally reads each account's Supabase admin record (`GET /auth/v1/admin/users/<id>`): a code is mailed only to an account that is not anonymous, has signed in to Merv before, belongs to a project, and whose admin record is confirmed, not banned, not deleted and has the same email; this is checked again before a key is issued. Such an account in no project yet is mailed how to create or join one instead of a code (a key needs a project to anchor it). Emails are lowercased before the lookup, as invitations do. `lookup_user_for_share` is unchanged.

The admin API needs a service-role key, so `identity` takes `directoryAdmin: true`, which refuses to boot unless `SUPABASE_SERVICE_KEY` is an `sb_secret_…` key or a JWT whose role is `service_role`. The `scope-api` plugin then takes:

```json
{
  "agentLogin": {
    "apiKeyEnv": "RESEND_API_KEY",
    "from": "Merv <login@rapidreview.io>",
    "publicOrigin": "https://experiments.rapidreview.io",
    "serverName": "merv"
  }
}
```

with optional `keyDays` (90), `retentionDays` (30), `limits` and `trustedProxies` (address ranges whose `X-Forwarded-For` is believed for the per-address limits; loopback only by default). For the hosted renderer set `MERV_AGENT_LOGIN=true` with the same two keys and `MERV_CONNECTOR_NAME`, the server name clients register: `merv` on production, `merv-staging` on staging. It has no default, so a staging connector can never take over production's registration. `MERV_AGENT_LOGIN_FROM` overrides the sender. The renderer trusts `127.0.0.1/32,::1/128,172.16.0.0/12` (`MERV_TRUSTED_PROXIES` overrides it): host Caddy reaches the published port `127.0.0.1:3081` from the Docker bridge gateway, so without the bridge range every client would share one per-address bucket. Keep it off in production until the staging check has passed with production's own service key; until then the Keys page and a refused `/mcp` call keep pointing people at keys, and the client plugins stay at 0.2.0.
