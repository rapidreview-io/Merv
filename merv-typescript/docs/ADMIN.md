# Platform admin

`/ui/admin` is the operator's view of the whole product: what work runs, what credit each person
holds per sandbox provider, and which credential serves which purpose. Only the human identities
in `MERV_ADMIN_IDENTITIES` (exact issuer/subject pairs, verified sign-in) may open it. Project
roles, user keys, machine keys and agent credentials never inherit it.

## Ownership

| Concern                                                  | Owner                                                                                                                         | What it exposes                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin identities, `/admin/*` routes, the admin audit log | `@merv/admin`                                                                                                                 | the only cross-project projections                                                                                                                                                                                                                                                                                                                                                                 |
| Platform read authority (`caller.platform`)              | `@merv/scope` slot, `@merv/admin` installs it                                                                                 | read-only, synthetic actor, never delegates                                                                                                                                                                                                                                                                                                                                                        |
| Platform caller tool rules                               | `@merv/api` registry `platform` kind, `@merv/admin` installs them                                                             | read tools only                                                                                                                                                                                                                                                                                                                                                                                    |
| Work state                                               | `@merv/workflows` (instances, definitions, blockers)                                                                          | terminal states per version                                                                                                                                                                                                                                                                                                                                                                        |
| Fleet spend, model-token ledgers, relay outcomes         | `@merv/fleet`                                                                                                                 | a read per ledger over UTC days [from, to); each person's own daily dollars and tokens (`fleet_usd_limits`, `fleet_model_limits`), which its caps enforce; each relay's latest success and failure per key and model, and whether the provider rejected the key                                                                                                                                    |
| Pi model-token ledger                                    | `@merv/pi`                                                                                                                    | a read over UTC days [from, to); each person's own daily tokens (`pi_model_limits`), which its charge enforces                                                                                                                                                                                                                                                                                     |
| Credits, providers                                       | Sandboxes (`sbxBilling`, `sbxProviders`)                                                                                      | in process; `CreditService` refuses new credit for a provider without an operator connection, and counts a provider's use per window (`usage`)                                                                                                                                                                                                                                                     |
| Each person's own Sandboxes account                      | the Merv↔Sandboxes bridge (`sandboxesPeople`, `@merv/sandboxes/integration`)                                                  | made at first sign-in and at start for everyone signed in before, with the configured welcome credit once (`MERV_NEW_PERSON_CREDITS`, e.g. `{"lambda":"25"}`); every credit write goes through it (`grant`, `schedule`), which also gives the account access to the provider's operator connections where no operator decided it (an access revoked stays revoked; a disabled schedule gives none) |
| Secret names and purposes per plugin                     | composition root (`composition.environment()`), each plugin's config schema, Sandboxes (`credential_env`, field descriptions) | env names from each plugin's `*Env` config fields with the schema's `.describe()`; a host provider's from its credential reference                                                                                                                                                                                                                                                                 |
| Stored platform secrets                                  | `@merv/secrets` (`platform_secrets`, secrets@2)                                                                               | sealed to their names; only the composition root writes and opens them (`override`, and at boot)                                                                                                                                                                                                                                                                                                   |

`@merv/admin` composes these reads and calls these writes. It owns no copy of another plugin's
rules: terminal states come from workflow definitions, spend from Fleet, credit arithmetic from
Sandboxes. It groups secrets by the plugin entry that names them (Agent: `pi`; Fleet agents:
`fleet-workflow`; Fleet machines: `fleet`, `sessions`; everything else Platform services). An
owner not loaded here leaves its facts out.

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
- `GET /admin/credits` — one row per person: each credit type's use today (UTC), its limit, own
  or not, and what is left. `GET /admin/credits/people/:person` — the drawer (`PersonCredits`):
  the same per window (today, last 7 days, last 30, all time), with their own account's grants and
  schedules. The types: the Agent's tokens (Pi), Fleet agent tokens and Fleet machine dollars
  (Fleet), and one per sandbox provider, whose use is its settled charges counted over the time
  each ran, its limit what is granted, what is left what is available.
- `POST /admin/credits/people/:person/limits` `{ kind, limit }` — sets or clears (`null`) the
  person's own daily limit in its owner (`pi.setTokenLimit`, `fleet.setPersonLimit`), recorded as
  `credits.limit`.
- `POST /admin/credits/grants`, `POST /admin/credits/schedules` (each names its `person`, on whose
  own account it lands) and `POST /admin/credits/grants/:id/revoke` — recorded in the admin audit
  log and answered with the `{ id }` written. A grant names its `validFrom`, so a retry repeats its
  terms exactly and replays. The admin checks only the body's shape: Sandboxes refuses the values
  (`sandbox_validation`).
- `GET /admin/credentials` — `AdminCredentials`: platform secrets grouped Agent, Fleet agents,
  Fleet machines, Platform services, each named by its owner's purpose, set or unset, which other
  names hold the same value, last change here, Fleet's relay's last success and failure, `dead`
  once the relay saw the provider reject the key with no success or change since, and `editable`;
  then the platform's sandbox provider keys (host instances; a key a person saved is theirs and not
  listed) with their plugin's descriptions and health; then the machine credentials Merv minted.
  Never a value.
- `POST /admin/credentials/reveal` `{ env }` or `{ provider, field }` → `{ value }`, and
  `POST /admin/credentials/change` `{ env, value }` or `{ provider, fields }` → `{ ok, reloaded }`:
  only a name an enabled entry's config gives, or a field Sandboxes lists for a host instance read
  from its credential env. Each is recorded as `credentials.reveal` or `credentials.change` with
  its target alone. A change goes through `composition.override`: the entries naming the env reload
  with the new value (a provider's instances rebind), and Secrets keeps it only once they took it;
  otherwise the previous value is back (`422 credential_rejected`). At boot, State and Secrets
  load alone and every stored value then replaces its env value; one the store's key no longer
  opens leaves the deployment's. Fixed, read only from the deployment (`editable: false`, `409
credential_fixed`): what State, Secrets, Identity and the Sandboxes host read, and any key whose
  purpose ends `· encryption key` or `· signing secret`.
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
customer snapshot at `/ui/admin/standalone/:requestId`. Credits and Credentials poll every 60 s.
Credentials draws one ruled table per purpose, then Sandbox providers and Machine credentials; a
row's quiet `Reveal` shows its value under it for 30 s, `Change` opens one password field. Credits
is one row per person and a column per credit type; a row opens the drawer at the right (the
page, on a phone): one 1D · 1W · 1M · Total switch for every type, and each type with its
control (`Set limit`, or `Give credit` and its grants and schedules behind ⋯). The pages read the
routes' types from `@merv/admin/models`.

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
