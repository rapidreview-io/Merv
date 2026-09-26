# Browser UI as a Cordis plugin

The UI is one optional plugin, `@merv/ui`, plus one small row adapter per feature. The left sidebar is the unifying surface: every row in it is registered by the plugin that owns the feature behind it, and a row disappears with its plugin while the shell keeps running.

## Shape

| Module               | Entry id       | Injects           | Owns                                                                                |
| -------------------- | -------------- | ----------------- | ----------------------------------------------------------------------------------- |
| `@merv/ui`           | `ui`           | `api`, `tools`    | The `ui` row and Running registries, the `/ui` bundle, `ui.*` tools, a Settings row |
| `@merv/scope/ui`     | `scope-ui`     | `scope`, `ui`     | People (a directory; no count)                                                      |
| `@merv/tasks/ui`     | `tasks-ui`     | `tasks`, `ui`     | Tasks (count of tasks not done or failed)                                           |
| `@merv/reviews/ui`   | `reviews-ui`   | `reviews`, `ui`   | Reviews (count of unclaimed and started reviews); Running's Review section          |
| `@merv/artifacts/ui` | `artifacts-ui` | `artifacts`, `ui` | Artifacts                                                                           |
| `@merv/sessions/ui`  | `sessions-ui`  | `sessions`, `ui`  | Sessions, runner presence and project dispatch controls                             |
| `@merv/feed/ui`      | `feed-ui`      | `feed`, `ui`      | Feed (posts and state changes as one column)                                        |
| `@merv/mounts/ui`    | `mounts-ui`    | `mounts`, `ui`    | Connections (degraded when any mount is not ready; data via `ui.read`)              |

Every entry is `required: false`. The default configuration lists all of them except `mounts-ui`, which belongs next to a `mounts` entry.

A row is data, not code:

```ts
ctx.effect(() =>
  ctx.ui.register({
    id: 'feed',
    label: 'Feed',
    group: 'activity', // sidebar section; `settings` rows render in the foot
    order: 30,
    path: '/feed', // browser route under /ui
    view: { kind: 'feed' }, // what the bundle renders
    status: (caller) => ({ count: 3 }), // optional live status shown on the row
    // A count always means open work against the project, never a total: tasks
    // not done or failed, experiments outside complete/abandoned/failed, reviews
    // requested or started, cycles, reflections and consolidations not finished,
    // live sessions. A row you consult rather than work — Records,
    // Artifacts, People, Code, Connections, Paper — reports no count at all, and
    // an absent count renders as nothing rather than as a zero.
    read: (caller) => data, // optional row-owned data served by ui.read
  }),
);
```

The registration lives inside a Cordis effect, so Cordis disposes it when the adapter unloads. Disabling `feed` suspends `feed-ui`, and the next `ui.shell` call no longer lists Feed. The bundle polls `ui.shell` every four seconds, so the sidebar follows within that interval. A row whose `view.kind` the bundle does not know still renders a page that says so.

Domain plugins never import the UI. Adapters import only the public `@merv/ui/types` contract, and the boundary test holds `ui.ts` adapters to the same rules as `tools.ts` adapters: inject the owner and the registry, nothing else.

## Tools

- `ui.shell` (read-only): the registered rows with live status, plus the plugin lifecycle table the composition root publishes (`createApp`'s own status), or none when the UI plugin is composed without `createApp`.
- `ui.read` (read-only): `{ rowId }` returns the data a row owns when it declares `read`; otherwise `row_unreadable`.

Both are ordinary catalog tools, visible to agents as well as the browser.

- `ui.running` (read-only): the Running board, composed from every registered Running contribution (below): three lanes of nodes, each lane's summaries, and the edges between nodes.
- `ui.running_panel` (read-only): `{ key }` returns one node's sidebar; `running_not_found` when no owner answers for the key.

These two are a person's monitor: no agent conversation is offered them, and both refuse leased workers and managed runners with `running_forbidden`. `@merv/ui` registers the page itself as the `running` row (`/running`, first under Agents), with no status and no read of its own: the page reads these two tools (`views/running.tsx`).

## Running contributions

The Running page draws everything in flight from contributions that the owning plugins register in their existing ui adapters. `ctx.ui` carries the registry, so an adapter injects nothing new for it; Sandboxes' adapter alone also injects `scope`, the one boundary rule already allows, to offer Extend lease and Release machine only to a caller the tools would let act.

```ts
ctx.effect(() =>
  ctx.ui.contribute({
    owner: 'tasks', // unique while registered; the board orders ties by owner
    kinds: ['work'], // key kinds whose sidebars this owner answers
    lanes: ['work'], // lanes it draws in; a failure is reported there
    nodes: async (read) => ({ nodes: await ctx.tasks.running(read.caller, read.include) }),
    panel: async (read, key) => await ctx.tasks.runningPanel(read.caller, keyId(key)),
  }),
);
```

The vocabulary is `@merv/contracts`' `running.ts`: nodes, marks, lane summaries, sidebar parts and sections, and the values a phrase is made of. Owners send instants and never write durations, arrows or identifiers as words; the shell ticks every clock and draws every arrow. Machine text (`mono`) is sent whole, a branch as an operator fetches it: the shell prints an id or a digest inside it by its head and its tail, and keeps all of it for the hover title and the copy control. Every member is optional:

- `marks(read)`: attention on keys other owners draw. Marks are read first, and every marked key reaches every `nodes()` as `read.include`, so the owner that draws it returns it even where its own rule would drop it.
- `nodes(read)` and `summary(read)`: the owner's cards and its lane line. A cached source reports `asOf`, `freshForMs` and `failed`, and `pending` until it has been filled once.
- `panel(read, key, absorbedBy?)`: the sidebar of a key this owner draws, or null for one it does not. The first contribution of the key's kind that answers owns it; a 404 or null means “not mine”, and any other refusal is the answer. An owner whose cache has not been filled yet answers a 503 rather than null, so the sidebar asks again instead of saying the key is gone.
- `sections(read, keys)`: sections about keys other owners draw, placed by `place`.

`read.once(name, fn)` shares one read between the members of one contribution for one answer. Both tools are read-only, so every member runs inside one PostgreSQL snapshot: nothing may write (the state layer refuses it), and nothing may wait on a service outside this process — read a cache the service fills on its own timer instead. Call a service's own `get()` or `process()` outside any transaction you opened yourself; each opens its own read on the same snapshot. Members are read one at a time, each behind its own savepoint (`state.isolated`), so a statement that fails in one — a bad cast, a timeout — is rolled back to that savepoint and costs that member alone; a member that catches its own failed statement still fails, and a read it leaves running after it returns is closed. A part refused with 403 or 404 is absent; any other failure names the owner in its lanes' `failed`, and the rest of the board stands. So an owner that reads another service for each of its rows catches that service's 404 for the row — a review a task names that Reviews does not hold — and draws the row without it, or leaves that row out, rather than letting one dangling reference take its whole part off the board unmarked. An owner whose ui adapter is configured but not running (failed, or waiting on a plugin it needs) is named in `failed` too, in the lanes it would draw in, so its silence never reads as “nothing running”. In a sidebar, a failed section contributor or absorbed owner is left out; a failure in the owner walk other than a 404 is the answer. What breaks the contract is left out, never forwarded.

The board, not the owner, decides three things: a node that lists another owner's key in `aliases` absorbs it (and whatever that absorbed), so the thing is drawn once; a work node's dot comes from the sessions working on or reviewing it; and each lane counts what needs a person in `needsYou`. Only the owner's controls reach a sidebar, and only those it allowed for this caller whose tool this server has.

## Serving

`@merv/ui` mounts `/ui` on the existing API server through `api.mount(prefix, handler)`. The mount is public: HTML, CSS, and JavaScript need no token. Data calls go to the same-origin `/tools/<name>` endpoints with a bearer token, so the API server now accepts requests whose `Origin` equals its own `http://<host>`; foreign origins still need `allowedOrigins`. Routes without a file extension fall back to `index.html` for the client router; dot segments never escape the bundle directory. Without a built bundle, `/ui/` answers `503 ui_not_built`.

Configuration: `{ "id": "ui", "name": "@merv/ui", "config": { "assets": "/path/to/dist" } }`. The default is `packages/ui/dist`, produced by:

```sh
npm run build:ui
```

`npm start` loads `config/default.json`, so the UI is available at `<url>/ui/` after that build. `npm run dev:ui` starts Vite with hot reload proxying tool calls to `http://127.0.0.1:3081` (override with `MERV_API`). `npm run demo:ui` starts a seeded server on port 3081 (`PORT` overrides), prints tokens for four actors, and accepts `disable <id>`, `enable <id>` (a plugin entry, such as `ui`) and `quit` on stdin.

## Browser

React 18 with Vite and `react-router-dom`, sources under `packages/ui/web/`, checked with `npm run typecheck:ui`. Sign-in takes a token or a whole credential file from `.merv/credentials/`; it is kept in session storage for that tab only. The shell reads `project.get` and `actor.whoami` for the project chip and account foot. Views call the domain tools directly (`task.list`, `review.get`, `artifact.read`, `feed.activity`, and so on) and render loading, empty, forbidden, and error states with the server's error code. Domain browsing is read-only. People/account views provide their documented administration, and Sessions provides operator-only dispatch and halt controls through authenticated HTTP.

Personal display preferences (theme, sidebar) stay in the browser. Plugin composition stays in the server's configuration file; the Settings page shows the plugin table and rows but cannot change them. The Sessions page has separate durable project dispatch controls; runner tuning is currently available through HTTP while the UI displays acknowledgement state.

## Verification

`npm run test:ui` covers the registry, the static mount including traversal attempts, same-origin acceptance, row listing per actor, feed removal and restoration, UI removal leaving HTTP and MCP working, the unbuilt-bundle response, and the Connections row against one live and one dead mount. `tests/boundaries.test.ts` enforces the adapter rules. Browser states were checked by hand against the seeded demo; the execution log records the checkpoints.

Task detail also displays a “What happens next” panel from the server-owned `task.get.guidance` decision. It uses the same gate, next action and blockers as the workflow tool and task context packages.

The [Sessions page](RUNNER_CONTROL_PLANE.md) shows authoritative live totals independently of its bounded history display. Browser verification covered enabling dispatch, pausing without closing a lease, and halting with the unfinished assignment returning to the queue. The development proxy forwards `/sessions` to the API alongside existing tool/account routes.

The Sessions view now includes a newest-first agent directory, a live-assignment switch, and a responsive right-hand inspector with assignment history, permitted tools, executed tool calls, timings and explicitly estimated input/output payload tokens. See [agent observations](AGENT_CONTINUITY.md#agent-activity-ui-and-observations) for accounting and visibility limits. `npm run demo:ui` also seeds an assigned researcher, an unassigned reviewer, a retired agent, and actual local Merv tool-call observations using disposable data; these are demonstration records, not connected model processes.
