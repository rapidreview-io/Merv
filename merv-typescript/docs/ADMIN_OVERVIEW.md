# Platform experiment overview

Open `/ui/admin` and sign in with a configured human account. This account-wide page does not require membership in customer projects. The server accepts only exact issuer/subject pairs in the UI plugin's `admins` configuration; project operators, machine keys and agent credentials do not inherit access.

Production configuration: `MERV_ADMIN_IDENTITIES` is a JSON array of `{ "issuer": "https://identity-provider/auth/v1", "subject": "verified-user-id" }`. Omitted or empty means the admin endpoint is not mounted. Resolve identities from verified sign-in rather than trusting an email supplied in a request.

`GET /admin/experiments` is authenticated, read-only and not cached. The projection combines project experiments, standalone experiments and unexpired offered/active worker leases. It excludes customer access tokens, idempotency secrets, checkout URLs and session credentials. Ordinary project ownership uses the stored actor name, which may be an account ID. Standalone email is known only after customer acceptance. Pi intake conversations are not execution leases.

The UI refreshes every 15 seconds. Its initial view contains nonterminal work, including planned work. Needs attention includes failed, ready-for-approval and awaiting-payment experiments. Updated means the last workflow transition, not a tool-call heartbeat. Lists are capped at 1,000 with nonterminal records first, and truncation is shown. A missing source is explicitly reported. Click an experiment for metadata; this page cannot approve, pay for, start or stop work.

The admin page uses a user sidebar and experiment cards with Active, Past and All filters. Registered identities appear even with no experiments; standalone email customers and unidentified guest requests are listed separately. Stored human-readable actor names and customer emails are preferred. Generic UUID/`Member <UUID>` labels fall back to the first four identifier characters. An admin identity may include an optional verified `label`; this affects presentation only, never authorization. Full identifiers are not displayed in the cards or detail panel.
