# Remote MCP OAuth cutover (not yet deployed)

This change requires an explicit deployment decision. It does not change the
running production service or revoke existing credentials automatically.

## New connection

Publish the new server/UI build together and explicitly set `MERV_MCP_OAUTH=true`.
Remove `MERV_AGENT_LOGIN`; keeping it enabled intentionally fails configuration
rendering with migration instructions. OAuth uses the existing browser identity
provider, not a directory-admin key or email delivery service. Keep invitation
email configuration when invitations are enabled.

Serve `/oauth/*`, `/.well-known/oauth-authorization-server`,
`/.well-known/oauth-protected-resource[/mcp]`, `/connect/*`, `/mcp` and `/ui/*`
through the same public HTTPS origin. Do not cache token, consent or discovery
responses. The application limits registration to 10 requests and authorization
to 30 requests per source per 60 seconds, before allocating durable records.
Limits are per process, group IPv6 sources by /64, cap memory at 10,000 counters,
and return HTTP 429 with Retry-After. Multiple replicas multiply these limits.

`MERV_OAUTH_TRUSTED_PROXY_IPS` optionally names comma-separated exact IP addresses
of immediate proxies (default: `127.0.0.1,::1`). Verify the actual Caddy socket peer
in the deployed container network before adding its bridge address. Only trusted
peers may supply the rightmost X-Forwarded-For address; otherwise limits use the
socket peer. Caddy must append the connecting address. Do not add arbitrary
networks or assume an upstream CDN. Additional ingress limits are optional.
Build the UI and run `npm run build:clients` before building the server. The
published bundle contains remote configuration and skills only; no executable
connector, proxy or daemon. Public plugin-directory publication is separate.

Tell users to read `/connect/agent.md` or open `/connect`. Download the provided
plugin archive, extract into a persistent user-owned directory, add that directory
as a marketplace, install Merv, and connect with browser sign-in. The website
handles account sign-in before consent. Project membership and selection are not required;
a verified person with zero projects can authorize. Git is optional.

The OAuth grant delegates current account memberships, including those added after
consent. Agents list projects and pass `projectId` explicitly for project operations;
there is no sticky default. Ask which project when ambiguous, including in fresh chats. It does not grant account
administration. Access tokens expire after an hour. Refresh tokens rotate on use;
reuse revokes the whole grant. The grant has a 30-day absolute lifetime. Revocation
is available through RFC 7009, Settings → Keys, and `/ui/account/keys`
(`OAuth: <client name>`), including after the last membership is removed.
Clients own credential persistence; Merv never copies credentials into skills or
asks for tokens in a conversation. OAuth bearers are accepted only on `/mcp`.

## Existing installations: migrate one client and one origin at a time

1. Privately back up the client's configuration. Inspect server names, transports
   and target URLs/commands, not stored secrets or headers. Check user and project
   scopes, plugin bundles and existing direct registrations for duplicates.
2. Disable the old skills-only or legacy Python Merv plugin. For the retired
   connector, remove only the registration whose command is the matching
   `~/.merv/connect/<host>/bin/merv-connect` (or invokes that host's
   `merv-connect.mjs`). Use the client's native remove command with the original
   scope. Do not remove an entry merely because it is named `merv`.
3. Remove only approval entries known to have been added by the old installer.
   Keep pre-existing permissions. Never replace a whole TOML/JSON configuration
   with an example. The old installed connector's `uninstall` can be used by its
   owner if they trust that installed version; do not download/run a new installer.
4. Install the new plugin and authenticate. Do not add a separate direct server
   alongside its bundled MCP. A deliberate direct-only fallback is documented in
   the guide for clients without plugin support. Keep unrelated registrations.
5. Verify project reads and an authorized reversible write; restart and repeat a
   read in a fresh chat. Only then revoke the old connector key in Settings → Keys,
   using its `email_code` provenance and machine label to identify it. Do not
   revoke all account keys: Git, CI and other clients may use those credentials.
6. Remove obsolete connector files only when no remaining client/origin uses
   them. Never delete `~/.merv/connect` wholesale. Credentials in the old private
   store must not be copied into the new plugin.

Old `/connect/login`, `/connect/install.sh` and connector download routes return
410 with the new guide. Existing keys remain usable until expiry or deliberate
revocation; memberships, actor IDs and review attribution are unchanged. The
published `agent_logins` migration and issuance evidence remain immutable. No
existing user/project data is rewritten. Machine/API-key endpoints remain.

## Rollback and rollout gate

Keep the previous application build available. The OAuth schema is additive;
rolling back code need not delete it or user keys. A rollback cannot use OAuth
bearers; clients must reconnect after OAuth is restored. Never silently turn the
email-code flow back on as a fallback. Deploy first in an isolated staging tenant
with distinct plugin names. Complete the real-client matrix in
[MCP_OAUTH_VALIDATION.md](../docs/MCP_OAUTH_VALIDATION.md) before production cutover.

## Release source packaging

Main and hosted releases both use `packageSource()` from `source-archive.mjs`.
It snapshots one Git commit, maps that commit's root `clients/` into the flattened
build context as `clients/`, and records every shipped client source in the source
manifest and content hash. Dirty or untracked client files are not release inputs.
The Docker allowlist includes these sources; `npm run build` regenerates the
server bundle from `/app/clients`. Full checkouts use the canonical root directory.
Do not build the release Dockerfile from a bare `merv-typescript/` checkout: use
the extracted committed archive used by the release scripts. Missing sources fail
the build; the generated TypeScript bundle is not a fallback for missing inputs.

`node --test deploy/source-archive.test.mjs` exercises packaging, extraction into
the flattened build layout, bundle regeneration, actual setup handlers and both
production/nonproduction plugin archives. It also verifies source hashes, omission
of dirty/untracked inputs and credential-shaped files, and that a committed skill
change changes the release content hash.
