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
| Credits, budgets, providers | Sandboxes (`sbxBilling`, `sbxProviders`, `sbxDb`) | in process; grants through `CreditService`, which refuses a provider without an operator connection |
| Secret names per plugin | composition root (`composition.environment()`), Sandboxes (`credential_env`) | env names from each plugin's `*Env` config fields; a host provider's from its credential reference |

`@merv/admin` composes these reads. It owns no copy of another plugin's rules: terminal states
come from workflow definitions, spend from Fleet, credit arithmetic from Sandboxes. Each read
names an owner not loaded here in `unavailable`.

## Routes (all `adminOf`; the API answers each `Cache-Control: no-store`)

- `GET /admin/work` — every nonterminal unit of work across projects, plus units ended in the
  last 24 hours: kind, title, project, person, state, attention, agent, machine, last activity,
  age, cost so far. Joined from each owner's platform read: `workflows.platformWork`,
  `sessions.running.platform`, `fleet.platformAllocations`, `pi.platformTurns`,
  `tasks.platformTypes`, `reflections.platformLensNames`, `customerExperiments.customers` and
  `scope.directory`. An agent's need is Sessions' own phrase; a machine is found by its
  allocation id or by the unit Fleet says it serves.
- `GET /admin/credits` — per person → sandbox account → provider: granted, used, reserved,
  available; schedules; budget caps; Fleet daily spend and model tokens.
- `POST /admin/credits/grants`, `POST /admin/credits/schedules`,
  `POST /admin/credits/grants/:id/revoke` — credit assignment through `CreditService`, each
  recorded in the admin audit log. A grant names its `validFrom`, so a retry repeats its terms
  exactly and replays; it answers `{ id }`. The admin checks only the body's shape: Sandboxes
  refuses the values (`sandbox_validation`).
- `GET /admin/credentials` — by purpose (Pi agents, Fleet agents, Fleet machines, sandbox
  providers, platform services): env name, set or missing, an 8-hex SHA-256 fingerprint, first
  seen, last success and last failure, `dead` once Fleet's relay saw the provider reject the key
  with no success or change since, live provider health. Never a value.
- `GET /admin/projects` — every project, newest first, for the drill-in picker:
  `{ projects: [{ id, name, createdAt }] }`.
- `GET /admin/standalone/:requestId` — a standalone experiment as its customer sees it (Customer
  experiments' own snapshot, without the customer's token); 503 where it is not installed.
- Tool calls with `x-merv-platform: read` — the user UI's own record pages for any project,
  read-only.

## Pages (`packages/ui/web/admin/`)

`/ui/admin` is an app of its own beside the projects (`AdminApp`, no project selected): a rail
with Work, Credits and Credentials and the admin's label at its foot. Work polls `/admin/work`
every 15 s into one table, attention first, with `Ended today` and the narrowing behind `Filter`
(`/` opens it); a row opens its record in the drill-in, a standalone experiment its customer
snapshot at `/ui/admin/standalone/:requestId`. Credits and Credentials read on load and on
`Refresh`; a person's row unfolds their accounts, grants (⋯ revokes), schedules (⋯ pauses or
resumes), budget caps and the one form that grants or schedules credit. The response types the
pages read are mirrored in `admin/types.ts`, since the server's own sit beside its composition.

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
`ResearchCommand`, a list's creation control, a running panel's act and the file upload draw
nothing. The server is the control.
The caller acts as `PLATFORM_ACTOR`, a reader no actor row backs; it never delegates, so it starts
no session, conversation or lease. Web refuses it (`403 web_forbidden`), so a drill-in spends no
project's web budget. Any other principal sending the header, and every MCP request with it, is
refused `403 platform_forbidden`. The first read of a project in an hour records `project.read` in
the admin audit log.
