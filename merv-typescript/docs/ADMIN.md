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
| Fleet spend, model-token ledgers, relay outcomes | `@merv/fleet` | a read method per ledger |
| Pi model-token ledger | `@merv/pi` | a read method |
| Credits, budgets, providers | Sandboxes (`sbxBilling`, `sbxProviders`, `sbxDb`) | in process; grants through `CreditService` |
| Secret names per plugin | composition root (`composition.environment()`) | env names from each plugin's `*Env` config fields |

`@merv/admin` composes these reads. It owns no copy of another plugin's rules: terminal states
come from workflow definitions, spend from Fleet, credit arithmetic from Sandboxes.

## Routes (all `requireAdmin`, `Cache-Control: private, no-store`)

- `GET /admin/work` — every nonterminal unit of work across projects, plus units ended in the
  last 24 hours: kind, title, project, person, state, attention, agent, machine, last activity,
  age, cost so far. Joined from each owner's platform read: `workflows.platformWork`,
  `sessions.running.platform`, `fleet.platformAllocations`, `pi.platformTurns`,
  `tasks.platformTypes`, `reflections.platformLensNames`, `customerExperiments.customers` and
  `scope.directory`; an owner not loaded is named in `unavailable`.
- `GET /admin/credits` — per person → sandbox account → provider: granted, used, reserved,
  available; schedules; budget caps; Fleet daily spend and model tokens.
- `POST /admin/credits/grants`, `POST /admin/credits/schedules`,
  `POST /admin/credits/grants/:id/revoke` — credit assignment through `CreditService`, each
  recorded in the admin audit log.
- `GET /admin/credentials` — by purpose (Pi agents, Fleet agents, Fleet machines, sandbox
  providers, platform services): env name, set or missing, an 8-hex SHA-256 fingerprint, first
  seen, last success and last failure, live provider health. Never a value.
- `GET /admin/projects` — every project, newest first, for the drill-in picker:
  `{ projects: [{ id, name, createdAt }] }`.
- `GET /admin/standalone/:requestId` — a standalone experiment as its customer sees it (Customer
  experiments' own snapshot, without the customer's token); 503 where it is not installed.
- Tool calls with `x-merv-platform: read` — the user UI's own record pages for any project,
  read-only.

## Drill-in

The admin opens a record in the member shell mounted at `/ui/admin/p/:projectId/…`. Every tool
call carries `x-merv-platform: read`; the API asks Scope for a platform caller, Scope asks the
installed platform authority (the admin plugin) to vouch for the verified identity, and allows
`read` only. The registry refuses every tool that is not read-only for platform callers before
its handler runs. The shell hides verbs when the session is read-only; the server is the control.
The caller acts as `PLATFORM_ACTOR`, a reader no actor row backs; it never delegates, so it starts
no session, conversation or lease. Any other principal sending the header, and every MCP request
with it, is refused `403 platform_forbidden`. The first read of a project in an hour records
`project.read` in the admin audit log.
