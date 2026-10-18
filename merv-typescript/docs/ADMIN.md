# Platform admin

`/ui/admin` is the operator's view of the whole product: what work runs, what credit each person
holds per sandbox provider, and which credential serves which purpose. Only the human identities
in `MERV_ADMIN_IDENTITIES` (exact issuer/subject pairs, verified sign-in) may open it. Project
roles, user keys, machine keys and agent credentials never inherit it.

## Ownership

| Concern | Owner | What it exposes |
|---|---|---|
| Admin identities, `/admin/*` routes, the admin audit log | `@merv/admin` | the only cross-project projections |
| Platform read authority (`caller.platform`) | `@merv/scope` slot, `@merv/admin` installs it | read-only, synthetic actor, never delegates |
| Platform caller tool rules | `@merv/api` registry `platform` kind, `@merv/admin` installs them | read tools only |
| Work state | `@merv/workflows` (instances, definitions, blockers) | terminal states per version |
| Fleet spend, model-token ledgers, relay outcomes | `@merv/fleet` | a read method per ledger; each relay's latest success and failure per key and model, and whether the provider rejected the key |
| Pi model-token ledger | `@merv/pi` | a read method |
| Credits, budgets, providers | Sandboxes (`sbxBilling`, `sbxProviders`, `sbxDb`) | in process; grants through `CreditService`, which refuses new credit for a provider without an operator connection |
| Secret names and purposes per plugin | composition root (`composition.environment()`), each plugin's config schema, Sandboxes (`credential_env`, field descriptions) | env names from each plugin's `*Env` config fields with the schema's `.describe()`; a host provider's from its credential reference |
| Stored platform secrets | `@merv/secrets` (`platform_secrets`, secrets@2) | set, read and list (names and times); the composition root applies them (`override`) |
| Provider keys | Sandboxes (`sbxProviders.connect`, `sbxVault`, `rebindHost`) | a user key verified then saved; a host instance rebound from its credential env |

`@merv/admin` composes these reads. It owns no copy of another plugin's rules: terminal states
come from workflow definitions, spend from Fleet, credit arithmetic from Sandboxes. An owner not
loaded here leaves its facts out.

## Routes (all `adminOf`; the API answers each `Cache-Control: no-store`)

- `GET /admin/work` — every nonterminal unit of work across projects, plus units ended in the
  last 24 hours: its workflow's name (`pi` for an Agent conversation, at its newest turn), title,
  project, person, state, attention (each owner's code, and its words where it has any), agent,
  machine, last activity, age, cost so far, and a standalone experiment's request. Joined from
  each owner's platform read: `workflows.platformWork`, `sessions.running.platform`,
  `fleet.platformAllocations`, `pi.platformTurns`, `tasks.platformTypes`,
  `reflections.platformLenses`, `customerExperiments.customers` and `scope.directory`. An agent's
  need is Sessions' own phrase; a machine is found by its allocation id or by the unit Fleet says
  it serves.
- `GET /admin/credits` — per person → sandbox account → provider: granted, used, reserved,
  available; schedules; budget caps; Fleet daily spend and model tokens.
- `POST /admin/credits/grants`, `POST /admin/credits/schedules`,
  `POST /admin/credits/grants/:id/revoke` — credit assignment through `CreditService`, each
  recorded in the admin audit log and answered with the `{ id }` it wrote. A grant names its
  `validFrom`, so a retry repeats its terms exactly and replays. The admin checks only the body's
  shape: Sandboxes refuses the values (`sandbox_validation`).
- `GET /admin/credentials` — `AdminCredentialsV2`: platform secrets grouped Agent, Fleet agents,
  Fleet machines, Platform services, each named by its owner's purpose, set or unset, which other
  names hold the same value, last change here, Fleet's relay's last success and failure, `dead`
  once the relay saw the provider reject the key with no success or change since, and `editable`;
  then every sandbox provider instance's key fields with their plugin's descriptions and health.
  Never a value.
- `POST /admin/credentials/reveal` `{ env }` or `{ provider, namespace, field }` → `{ value }`,
  and `POST /admin/credentials/change` `{ env, value }` or `{ provider, namespace, fields }` →
  `{ ok, reloaded }`: only a name an enabled entry's config gives, or a field Sandboxes lists for
  that instance. Each is recorded as `credentials.reveal` or `credentials.change` with its target
  alone. A platform secret is stored sealed in Secrets, applied, and the entries naming it reload
  (`reloaded`); a user's provider key goes through `connect` (verified, then saved); a host
  instance's key is stored as its credential env and the hub rebinds it (`reloaded` names it).
- `GET /admin/standalone/:requestId` — a standalone experiment as its customer sees it (Customer
  experiments' own snapshot, without the customer's token) and the move of theirs it waits on;
  503 where it is not installed. The first read of a request in an hour records `standalone.read`
  in the admin audit log.
- Tool calls with `x-merv-platform: read` — the user UI's own record pages for any project,
  read-only.

## Pages (`packages/ui/web/admin/`)

`/ui/admin` is an app of its own beside the projects (`AdminApp`, no project selected): a rail
with Work, Credits and Credentials and the signed-in admin at its foot. Work polls `/admin/work`
every 15 s into one ruled list, attention first, with kind, state and `Ended today` behind
`Filter` (`/` opens it); a row opens its record in the drill-in, a standalone experiment its
customer snapshot at `/ui/admin/standalone/:requestId`. Credits and Credentials poll every 60 s;
a person's row unfolds their accounts, each headed by what it holds per provider and its budget
caps, then its grants (⋯ revokes) and schedules (⋯ pauses or resumes), and the quiet `Grant`
word that opens the one form that grants or schedules credit. The pages read the routes' types
from `@merv/admin/models`; on a phone each row's facts stand under their names.

## Drill-in

The admin opens a record in the member shell mounted at `/ui/admin/p/:projectId/…`: `main.tsx`
takes that prefix as the router's base (`drillIn`), so every path a page links to stays inside
it. Every tool call and stream carries `x-merv-platform: read` (`scopeHeaders`); the API asks
Scope for a platform caller, Scope asks the installed platform authority (the admin plugin) to
vouch for the verified identity, and allows `read` only. The registry refuses every tool that is
not read-only for platform callers before its handler runs. The session opens the named project
without membership; one line above the shell reads `← Admin  <project>`. One flag, `readOnly()`,
hides the verbs: the pages that are only verbs (Agent chat, boards, Settings, the sandbox console)
lose their rows and routes, the dock is not mounted, and `Submit`, `ConfirmAction`,
`ResearchCommand`, a review's controls, a list's creation control, a running panel's act and the
file upload draw nothing. The server is the control. A refused drill-in keeps the sign-in: it
says why, with the way back to `/ui/admin`.
The caller acts as `PLATFORM_ACTOR`, a reader no actor row backs; it never delegates, so it starts
no session, conversation or lease. Web refuses it (`403 web_forbidden`), so a drill-in spends no
project's web budget. Any other principal sending the header, and every MCP request with it, is
refused `403 platform_forbidden`. The first read of a project in an hour records `project.read` in
the admin audit log.

## v2: operable credentials and credits (founder review, 2026-10-18)

Every view of a resource carries the control that changes it. Every fact is named by what it is
for, not by its implementation name. Details live in a right-side drawer, not in more columns.

### Credentials

- **Purpose labels come from the owner.** Each plugin describes its own secret fields in its
  config schema (`z.string().describe('Agent model calls · OpenAI')`), and
  `composition.environment()` returns that description beside `{ plugin, field, env }`. Sandbox
  provider fields keep their provider plugin's own field descriptions. The admin keeps no list of
  purposes.
- **Platform secrets** (`GET /admin/credentials`): rows `{ purpose, env, plugin, field, set,
  lastChanged, lastOk, lastFailure, dead, editable }`, grouped as Agent, Fleet agents, Fleet
  machines, Platform services. No fingerprint.
- **Sandbox provider keys** are their own table: one row per provider instance and credential
  field: `{ provider, plugin, source: host | user, namespace, field, description, secret, present,
  health, healthReason, verifiedAt, editable }`.
- `POST /admin/credentials/reveal` `{ env }` or `{ provider, namespace, field }` returns
  `{ value }`. It is one secret per call, never cached, and recorded in the audit as
  `credentials.reveal`. The page hides the value after 30 s.
- `POST /admin/credentials/change` `{ env, value }` or `{ provider, namespace, fields }` returns
  `{ ok, reloaded: string[] }` and is recorded as `credentials.change`.
  - **Platform secret:** `@merv/secrets` keeps an encrypted platform-secret store (AES-GCM under
    `MERV_SECRETS_ENCRYPTION_KEY`) whose value overrides the env value. The composition root
    applies stored values before plugins load. After a change, it applies the new value and
    reloads only the plugin entries whose config names that env.
  - **Sandbox provider:** the key goes through Sandboxes' own save path (verified against the
    provider before it is stored); a host instance's key is an override of its credential env.
  - **Boot:** State and Secrets load alone first; every stored value then replaces its env value
    before any other entry loads. No stored value replaces what State and Secrets read, or
    Identity's (the API verifies every request through it, so reloading it would end the request
    that changed it): those show `editable: false` and change in the deployment. A stored value
    that the key cannot open stops the boot. admin@2's fingerprint table is no longer read.

### Credits

- `GET /admin/credits` stays the list: one row per person with a total per credit type.
- `GET /admin/credits/people/:person` is the drawer: for each credit type `{ kind, label, unit,
  limit, used: { day, week, month, total }, left }`.
  - Internal types are read from their owners: the Agent's tokens (Pi), Fleet agent tokens (Fleet
    model ledger), and Fleet VM dollars (Fleet allocations).
  - External types: one per sandbox provider (Sandboxes credit pools and settlements, through the
    person's accounts), with their grants and schedules.
- `POST /admin/credits/people/:person/limits` `{ kind, limit }` sets a per-person limit, kept by
  the owner: Pi's per-person token limit, Fleet's per-person token and daily-dollar limits.
  Recorded as `credits.limit`.
- `POST /admin/credits/grants` (existing) takes `{ person }` as well as `{ accountId }`. A person
  is granted on their own account.
- **Every person has a Sandboxes account.** The Merv↔Sandboxes bridge (`@merv/sandboxes/integration`)
  makes sure each verified person has their own account and membership: at sign-in, and for
  everyone already signed in. It grants the configured base credits once
  (`newPersonCredits: { lambda: "<usd>" }`, from `MERV_NEW_PERSON_CREDITS`), under an idempotent
  grant id per person.
