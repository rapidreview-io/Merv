# Browser UI as a Cordis plugin

The UI is one optional plugin, `@merv/ui`, plus one small row adapter per feature. The left sidebar is the unifying surface: every row in it is registered by the plugin that owns the feature behind it, and a row disappears with its plugin while the shell keeps running.

## Shape

| Module               | Entry id       | Injects           | Owns                                                                                |
| -------------------- | -------------- | ----------------- | ----------------------------------------------------------------------------------- |
| `@merv/ui`           | `ui`           | `api`, `tools`    | The `ui` row registry, the bundle at `/ui`, `ui.shell`, `ui.read`, the Settings row |
| `@merv/scope/ui`     | `scope-ui`     | `scope`, `ui`     | People (a directory; no count)                                                      |
| `@merv/tasks/ui`     | `tasks-ui`     | `tasks`, `ui`     | Tasks (count of tasks not done or failed)                                           |
| `@merv/reviews/ui`   | `reviews-ui`   | `reviews`, `ui`   | Reviews (count of unclaimed and started reviews)                                    |
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

- `ui.shell` (read-only): the registered rows with live status, plus the plugin lifecycle table from the loader when one is present.
- `ui.read` (read-only): `{ rowId }` returns the data a row owns when it declares `read`; otherwise `row_unreadable`.

Both are ordinary catalog tools, visible to agents as well as the browser.

## Serving

`@merv/ui` mounts `/ui` on the existing API server through `api.mount(prefix, handler)`. The mount is public: HTML, CSS, and JavaScript need no token. Data calls go to the same-origin `/tools/<name>` endpoints with a bearer token, so the API server now accepts requests whose `Origin` equals its own `http://<host>`; foreign origins still need `allowedOrigins`. Routes without a file extension fall back to `index.html` for the client router; dot segments never escape the bundle directory. Without a built bundle, `/ui/` answers `503 ui_not_built`.

Configuration: `{ "id": "ui", "name": "@merv/ui", "config": { "assets": "/path/to/dist" } }`. The default is `packages/ui/dist`, produced by:

```sh
npm run build:ui
```

`npm start` loads `config/default.json`, so the UI is available at `<url>/ui/` after that build. `npm run dev:ui` starts Vite with hot reload proxying tool calls to `http://127.0.0.1:3081` (override with `MERV_API`). `npm run demo:ui` starts a seeded server on port 3081 (`PORT` overrides), prints tokens for four actors, and accepts `disable feed`, `enable feed`, `disable ui`, `enable ui`, and `quit` on stdin.

## Browser

React 18 with Vite and `react-router-dom`, sources under `packages/ui/web/`, checked with `npm run typecheck:ui`. Sign-in takes a token or a whole credential file from `.merv/credentials/`; it is kept in session storage for that tab only. The shell reads `project.get` and `actor.whoami` for the project chip and account foot. Views call the domain tools directly (`task.list`, `review.get`, `artifact.read`, `feed.activity`, and so on) and render loading, empty, forbidden, and error states with the server's error code. Domain browsing is read-only. People/account views provide their documented administration, and Sessions provides operator-only dispatch and halt controls through authenticated HTTP.

Personal display preferences (theme, sidebar) stay in the browser. Plugin composition stays in the server's configuration file; the Settings page shows the plugin table and rows but cannot change them. The Sessions page has separate durable project dispatch controls; runner tuning is currently available through HTTP while the UI displays acknowledgement state.

## Verification

`npm run test:ui` covers the registry, the static mount including traversal attempts, same-origin acceptance, row listing per actor, feed removal and restoration, UI removal leaving HTTP and MCP working, the unbuilt-bundle response, and the Connections row against one live and one dead mount. `tests/boundaries.test.ts` enforces the adapter rules. Browser states were checked by hand against the seeded demo; the execution log records the checkpoints.

Task detail also displays a “What happens next” panel from the server-owned `task.get.guidance` decision. It uses the same gate, next action and blockers as the workflow tool and task context packages.

The [Sessions page](RUNNER_CONTROL_PLANE.md) shows authoritative live totals independently of its bounded history display. Browser verification covered enabling dispatch, pausing without closing a lease, and halting with the unfinished assignment returning to the queue. The development proxy forwards `/sessions` to the API alongside existing tool/account routes.

The Sessions view now includes a newest-first agent directory, a live-assignment switch, and a responsive right-hand inspector with assignment history, permitted tools, executed tool calls, timings and explicitly estimated input/output payload tokens. See [agent observations](AGENT_CONTINUITY.md#agent-activity-ui-and-observations) for accounting and visibility limits. `npm run demo:ui` also seeds an assigned researcher, an unassigned reviewer, a retired agent, and actual local Merv tool-call observations using disposable data; these are demonstration records, not connected model processes.
