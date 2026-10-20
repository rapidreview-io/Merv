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

`/connect` lets a person's own agent sign a machine in by an emailed code (`packages/scope/src/connect.ts`, `agent-logins.ts`). It reuses the directory lookup and the Resend sender, and additionally reads each account's Supabase admin record (`GET /auth/v1/admin/users/<id>`): a code is mailed only to an account that is not anonymous, has signed in to Merv before, belongs to a project, and whose admin record is confirmed, not banned, not deleted and has the same email; this is checked again before a key is issued. Any other address, including an account in no project yet (a key needs a project to anchor it), is mailed nothing, and every start answers alike. Emails are lowercased before the lookup, as invitations do. `lookup_user_for_share` is unchanged.

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

with optional `keyDays` (90), `retentionDays` (30), `limits` and `trustedProxies` (address ranges whose `X-Forwarded-For` is believed for the per-address limits; loopback only by default). For the hosted renderer set `MERV_AGENT_LOGIN=true` with the same two keys and `MERV_CONNECTOR_NAME`, the server name clients register: `merv` on production, `merv-staging` on staging. It has no default, so a staging connector can never take over production's registration. `MERV_AGENT_LOGIN_FROM` overrides the sender. The renderer trusts loopback only (`127.0.0.1/32,::1/128`) unless `MERV_TRUSTED_PROXIES` names more. Production sets `MERV_TRUSTED_PROXIES=127.0.0.1/32,::1/128,172.18.0.1/32`: host Caddy reaches the published port `127.0.0.1:3081` from the Docker bridge gateway `172.18.0.1`, so without it every client would share one per-address bucket. Name that gateway's own `/32`, never the bridge range: any container that can reach Merv directly would then forge `X-Forwarded-For`.

Limits. A start is refused past 3 per email in 15 minutes, 10 per email a day, 10 per address an hour and 30 per network an hour (`networkPerHour`: an IPv4 address or an IPv6 `/48`), counted on every stored request whether or not the email has an account; a refused start stores nothing and an admitted one stores one row. Merv's own caps, 30 a minute and 500 a day (`globalPerMinute`, `globalPerDay`), count only codes sent: a code is reserved for an eligible person in the transaction that checks the caps, so starts for unknown or ineligible addresses spend none of them. Past either cap every start is refused with `login_capacity` and nothing more is sent, while verifies go on. Codes are mailed in the background, 4 at a time (`queueConcurrency`); an admitted start is never refused for a busy queue but held, oldest first, and mailed as a slot frees. A held start is dropped once its sign-in expires, and past 10,000 held (`queueWaiting`) the oldest is dropped. A verify is admitted in process before its body is read or the store is asked, in fixed one-minute windows: 30 a minute per IPv4 address or IPv6 `/64` (`verifyPerIpMinute`) and 120 per IPv6 `/48` (`verifyPerNetworkMinute`; an IPv4 address is one bucket, at the first limit), with no cap across all callers, so no network can spend another's attempts; a refused verify is `login_rate_limited`, too many attempts. Each request is constant work, and a window tracks at most 100,000 buckets: past that a request in an untracked bucket is admitted without being tracked, while the buckets already counting still hold. That fails open safely: an admitted verify costs one bounded primary-key read, and guessing stays capped at 5 tries per sign-in. A malformed sign-in id is refused without a lookup; any other costs one primary-key read. A start's address is an IPv4 address or an IPv6 `/64`, so rotating through one prefix buys nothing. Each sign-in also locks after 5 wrong codes.

Accepted: someone who knows a person's email can start sign-ins for it and use up its per-email limits, blocking new codes for that email for up to 15 minutes, or until the next UTC day once 10 are spent; someone holding many eligible people's emails can likewise spend the caps on sends. A distributed attacker with many addresses can delay new sign-in codes, by filling the delivery queue from many networks, or make Merv do bounded database reads, by verifying from more buckets than a window tracks. In every case codes already sent keep working, nothing signs in without the code, and the person can always make a key on the Keys page instead.

The connector refuses a `~/.merv` path it cannot trust before it reads a key or replaces itself: each directory from `$HOME` down to `~/.merv/connect/<host>` must be the person's own (`$HOME` may be root's), not a link and not writable by group or others; directories it creates are `0700`, and it reads every file through one descriptor opened without following links, checked there as the person's own `0600` file. The installer downloads into a private temporary directory, checks the digest, and runs the connector's `install`, which checks the directories, reads itself the same way, checks the digest again and copies itself in. Keep it off in production until the staging check has passed with production's own service key; until then the Keys page and a refused `/mcp` call keep pointing people at keys, and the client plugins stay at 0.2.0.
