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

## Agent connections

Agent connections now use standard remote MCP OAuth with the existing browser
identity provider. No email sender or admin directory key is required for OAuth.
See [connection migration](../deploy/CLIENT_CUTOVER.md). The custom email-code
agent flow and its installer are retired; existing key provenance is retained.
