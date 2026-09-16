# Shared identity and project membership

Merv can now verify identities from the same Supabase project used by Nisa.
Identity verification is an independent Cordis provider. Scope owns users,
project membership and permissions; existing domain plugins continue receiving
project-scoped callers and checking them inside their transactions.

This is a local implementation with signed-identity integration tests. Production
shared login still needs the intended Supabase configuration and a real browser
sign-in check. [User-owned project/account keys](USER_KEYS.md) are now integrated;
agent sessions and runners remain separate parity work.

## Identity and authority

| Record           | Purpose                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verified user    | Stable `(issuer, subject)` identity accepted after signature and claim verification. Email and profile roles never grant Merv permission.               |
| Membership       | One user's role in one project. Invitations can name an external subject before first login; an invitation does not verify that identity.               |
| Member actor     | Persistent attribution identity for that membership's person/project. It has no locally minted bearer. Different projects have different member actors. |
| Actor credential | Existing project-bound machine/person key. It remains separate from verified human account authority and cannot manage memberships.                     |
| Membership epoch | An immutable ID for a particular grant. Role changes and rejoining create a new epoch; in-flight callers carrying an older epoch are refused.           |

The roles remain `operator`, `producer`, `reviewer` and `reader`. Only a verified
human with operator membership may add/remove members or change their roles.
Every human member may read membership history. The final verified human operator
cannot be removed or demoted; an invitation alone does not satisfy that safeguard.
The check and mutation share the same serialized transaction.

Project creation, initial membership, its receipt and audit event commit together.
A retry with the same human/request ID returns the same project; changed input
conflicts, and replay still requires current access. Removing an absent membership
is harmless. Removing access to project A preserves identity and authorized access
to B. Generic actor tools cannot mint credentials for or revoke member actors.

Membership removal deactivates its actor and records recovery atomically. Role
changes record `actor.permissions_changed`; loss of review permission releases
affected review claims. Attribution, evidence and membership history remain.
Local ownership repair reasons are visible only to project operators in activity.

Restoring access does not revive the old review claim. Reviews checks the committed
loss event during admission and submission, even before the recovery consumer
releases that claim. Context, checkpoints and workflow begin share this check.
A fresh claim started after the loss remains valid when delayed recovery runs.

## Provider configuration

Replace the default empty `identity` configuration with the shared Supabase origin:

```json
{
  "id": "identity",
  "name": "@merv/identity",
  "config": {
    "supabaseUrl": "https://YOUR-PROJECT.supabase.co",
    "publishableKeyEnv": "SUPABASE_PUBLISHABLE_KEY"
  }
}
```

Set the named environment variable to the public Supabase publishable key or its
legacy anonymous key. This value is the only key exposed to the browser. Secret
API keys and service-role JWTs are rejected by public configuration validation.
The default empty configuration disables shared login and preserves local actor
credentials.

The default verifier uses the issuer's fixed JWKS endpoint, permitting ES256 and
RS256 signatures. It requires exact issuer/audience, a subject, finite unexpired
`exp` and the signed `authenticated` role, and rejects anonymous users. Clock
skew is zero. Key URLs supplied in a JWT are ignored. JWKS responses have size,
key-count and five-second request/body bounds; the successful cache lasts five
minutes, with a 30-second unknown-key/failure cooldown. These choices use
[Supabase's signing-key endpoint](https://supabase.com/docs/guides/auth/signing-keys)
and [jose's verifier](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md).

For an existing HS256 deployment, explicitly set `mode: "hs256"` and
`secretEnv: "SUPABASE_JWT_SECRET"`. Supply the server's existing signing secret
through that environment variable. HS256 and JWKS are exclusive modes; there is
no fallback from one to the other. `audience` defaults to `authenticated`.
`allowLocalHttp: true` permits loopback HTTP for local development only.

Verification performs asynchronous crypto/network work before State transactions.
Known verified users take a read path; first recognition is inserted atomically.
No access or refresh JWT is stored in State, events or context packages. Offline
verification follows issuer-signed expiry; it does not immediately observe upstream
logout or account deletion. Current Merv membership is rechecked independently.

## HTTP and MCP

Account operations work even before a person belongs to any project:

| Route                                   | Result / input                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /auth/config`                      | Public enabled/login configuration, containing no server secret.                         |
| `GET /account`                          | Authenticated principal and reachable projects. Actor keys see only their fixed project. |
| `GET /projects`                         | Reachable projects.                                                                      |
| `POST /projects`                        | Human: `{ "name": "Project", "requestId": "stable-request-id" }`.                        |
| `GET /projects/:id/members`             | Human member: membership history.                                                        |
| `POST /projects/:id/members`            | Human operator: `{ "subject": "external-user-id", "role": "reviewer" }`.                 |
| `PATCH /projects/:id/members/:subject`  | Human operator: `{ "role": "reader" }`.                                                  |
| `DELETE /projects/:id/members/:subject` | Human operator: remove membership.                                                       |

All private routes require a bearer. Human tool calls and catalogs require an
explicit Merv project selection. HTTP uses `X-Merv-Project-Id`; native calls also
accept their existing `projectId` argument. MCP supports the header and
`_meta["merv/projectId"]`, including `tools/list`. Conflicting selections fail.
Mounted tools retain their upstream arguments unchanged, including upstream
`projectId` values. Actor keys can never select another project.

The registry rechecks the caller immediately before queued dispatch. Domain
permission checks revalidate membership epoch, current role and JWT expiry in
the mutation transaction. Scoped resource lookups independently reject another
project's IDs. Shared login does not automatically create mounted-tool grants,
credential bindings or permission to forward a JWT upstream.

## Browser and first run

The UI supports shared-account password/Google login through the Supabase SDK,
using PKCE and per-tab session storage. Password exchange and refresh go directly
to Supabase; Merv receives only access JWTs. Existing pasted bearer credentials
remain supported. The SDK owns OAuth exchange and refresh, following its
[auth event contract](https://supabase.com/docs/reference/javascript/auth-onauthstatechange).

A person with no projects can create one. Project selection is explicit; changing
projects resets the current route and component state, updates request scope and
rejects stale responses. Membership loss refreshes project choices instead of
assuming that the whole account was revoked. The People view exposes human
membership controls under server-enforced permissions.

Refresh belongs to the current account. Concurrent expiry responses share one
refresh and retry once; role refusals do not trigger refresh. Switching accounts
or projects invalidates older responses, including responses still parsing JSON.
These behaviors have synthetic browser-client tests; a real Supabase browser
sign-in has not been verified in this wave.

`serve` can start without a local `credentials.json` when shared identity is
enabled. For an HTTPS reverse proxy, configure the API's exact public UI origin
in `allowedOrigins`; the built-in server itself speaks HTTP.

## Legacy projects and local repair

No login automatically acquires an existing project. A trusted administrator on
the Merv host can explicitly adopt an unowned legacy project:

```sh
npm run cli -- adopt-project --dir .merv --config config/shared.json \
  --project PROJECT_ID --token-env MERV_HUMAN_ACCESS_TOKEN
```

The named environment variable contains the destination person's current access
JWT. The command verifies it, loads only State/Scope/Identity and grants operator
membership without changing existing actor credentials. The project and new user
remain distinct from the local machine operator.

If an already-owned project loses its usable administrator login, add an explicit
`--repair-reason "Reason for ownership repair"`. This records `membership.repaired`
and restores/grants the verified destination account operator membership. The
ordinary command still refuses projects with membership history. This is local
host administration; neither adoption nor repair is exposed over HTTP or MCP.

See [identity/session sequence](IDENTITY_SESSION_PARITY_PLAN.md),
[Fable design review](reviews/shared-identity-fable-design.md) and the dated
[verification record](../verification/shared-identity.json).
