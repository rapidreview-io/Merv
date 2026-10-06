# Current plugin dependencies

Open the [interactive sketchbook](explorer/index.html) to hover over dependencies, select plugins, follow their consumers, and inspect exposed tools. Its editable sources and refresh instructions are in the [explorer guide](explorer/README.md). `npm run docs:architecture` regenerates it alongside the inventory.

The JSON and Mermaid sources are extracted from current `inject` declarations by `npm run docs:architecture`. The checked-in Graphviz SVG/PNG and five DOT panels are a historical 2026-09-16 layout until regenerated; use `current-dependencies.json` for the current inventory. The panels cover domain providers, transport, research programs, Paper, Sessions, Code and the independent machine Runner.

State uses PostgreSQL; production Blobs uses S3/R2 without adding provider dependencies. The optional `@merv/legacy-history` reader (State, Scope) and its `@merv/legacy-history/ui` page expose human-only reads of imported history through the existing `ui.read` tool and link retained files to ordinary Artifacts. They are outside the default composition and are included in the generated inventory and explorer; they add no workflow engine or agent tool.

The current inventory has 69 plugin entrypoints: 31 service providers, 18 tool adapters, 15 UI adapters and five API adapters. It records 192 direct Cordis dependencies, including 23 optional integrations. There are 68 server entrypoints and one independent machine entrypoint. The default server configuration selects 50 entries; API-only selection uses 39. Scope, Secrets, Sessions, Code Work and Pi publish their HTTP routes through their own API adapters. Optional bindings include Experiments, Knowledge and Tasks → Code Work, and Research → its stage providers. The retired Consolidation and Claims plugins are absent.

Some providers repeat as reference blocks across panels; each is one shared provider. Solid arrows mean the source plugin requires the target service through Cordis. Dashed arrows mark optional integrations. The dotted Runner-to-API arrow is an HTTP connection and is explicitly excluded from the Cordis dependency count. These arrows do not guarantee remote health. The local Nisa and Sandboxes providers use their remote HTTP APIs directly; optional MCP mounts can also expose those external services through Mounts.

Task types own context recipes directly. There are no task-context adapter plugins. Reviews depends on Domain Events for revocation recovery; Tasks depends on Context Builder for recipe registration and package assembly. Workflows owns assignment leases; Agent Sessions binds agents to their current execution. The outer Research program advances explicitly and does not launch agents.

Research claims are retired. At startup Artifacts converts any remaining claim into a Markdown text artifact titled `Claim: …` and drops the claims tables; claim events stay in the event log. This adds no dependency to Artifacts.

Experiments requires State, Scope, Artifacts, Workflows, Reviews, Context Builder, Paper and Domain Events, with optional Code Work and Sandboxes integrations. It owns attempts, exact evidence rounds, metrics exhibits, four node recipes and review routing. Code Work provides exact workspace/commit capture references for the versioned Git execution path. Its adapters expose six experiment tools, ten compute tools and the Experiments page. Recovery uses Domain Events and the generic Workflows/Reviews contracts; Experiments has no direct Sessions dependency.

Knowledge requires State, Scope, Tasks, Experiments, Artifacts, Reviews and Workflows, with optional Code Work integration. It composes project records and scoped reference metadata through public domain contracts. Its tools are `project.records` and `project.references`; it has no UI adapter, and the former /knowledge URL redirects to Paper. Current project intent, terminal work, code proposals and exact captures can be inspected without creating a Reflection publication or reading artifact bytes. Workflow gates and next actions remain in Workflows; Workflows supplies the metadata needed to resolve workflow and review references.

Paper requires State, Scope and Artifacts. It stores documents, citations, immutable proposed edits and reviewed revisions. It has no Workflows, Context Builder or Knowledge dependency. Experiment and reflection owners submit and accept changes through their existing scientific reviews.

Reflections requires State, Scope, Artifacts, Paper, Workflows, Reviews, Context Builder and Domain Events. It has no Knowledge or Research dependency. It starts five independent lens workflows over live project research, assembles compact assignment context, and routes independent review. Workflows pauses new task/experiment creation until approval; existing work continues. Research supplies current research-linked evidence permissions through an optional Workflows callback. Removing Research or Knowledge leaves reflection assignments, leases and submissions active. This does not make Reflections independent of its own required Paper provider. Approval retains immutable report, change specification and lens provenance. Review contributor exclusions prevent lens authors from reviewing their own synthesis.

Consolidation is now an ordinary Git Task injected by Research after a reflection is independently approved. Tasks owns delivery and review; Code Work owns captures, repository admission and publication. The dedicated Consolidation plugin and its candidate-freeze API are retired. Its database and Git facts remain retained.

Research requires State, Scope and Workflows. Domain Events, Paper, Reflections, Tasks, Experiments, Artifacts and Code Work bind as optional providers. Current `research@6` cycles move through definition, selected research and independent reflection; when accepted code is missing from main, Research injects a Git Task for integration and waits for its acceptance and publication. It can complete without that task when main already holds the code. Cycle digests read only selected tasks and experiments directly, without a Knowledge dependency or project-wide scan. Missing providers block only the operations that use them, and a replaced provider cannot commit an in-flight result. Historical cycles that require the retired Consolidation workflow report `research_consolidation_retired` at its handoff while retaining their stored records. See [Research cycles](../RESEARCH.md).

Sessions owns agent identity and session continuity, while Workflows owns assignment leases and Scope enforces security actors. Existing execution IDs stay fixed for evidence and stale-call fencing. See [agents and assignment executions](../AGENT_CONTINUITY.md).

Scope owns the project Introduction and its revision/retry receipts, exposed through `project.context.update`. This adds no provider. Tasks retains the Introduction captured at lease offer in its existing immutable lease receipt, while ordinary newly built task context reads the current Introduction.

Sessions requires State, Scope, Workflows, and Domain Events, and stores session transcripts through Blobs whenever Blobs is loaded. Program registration hooks provide domain ownership and recovery without adding direct Sessions-to-Tasks or Sessions-to-Reviews dependencies. Its `sessions-api` adapter requires Sessions and API and publishes its HTTP controls, which add no MCP tools. The optional `sessions-ui` adapter requires Sessions and UI, and publishes the project dispatch/session page.

The core Code provider requires State and Scope. Code Work requires Code, State, Scope, Sessions, Artifacts, Workflows and Domain Events; Reviews and Sandboxes bind optionally. Its tools expose checkpoints, repository controls and publication controls. Its separately composed API adapter requires Code Work and API and connects the Runner to durable commands and receipts. Code Work seals immutable proposal manifests and supports the ordinary Git-unit review and publication path used by Tasks. See [the Code contract](../CODE_OPERATIONS.md).

Reviews owns the generic `review.submit` tool and routes it to exactly one disposable domain owner. Tasks, Experiments and Reflections register their domain callbacks through their existing Reviews dependencies. Removing an owner withdraws its callback. This adds no Cordis dependency from Reviews to Tasks or future domain programs; callback registration is not an extra graph arrow.

Runner provides `runner` and declares `inject: []`. It runs in a separate machine Cordis context, calls server session and Code command controls over HTTP, and supervises local agent processes. Its private local SQLite launch ledger is independent of the server State plugin. It adds no MCP tools, server inject edges, or default server entries. See the [Runner process foundation](../../packages/runner/README.md) for ownership and recovery guarantees and their limits.

These files represent current declarations, not a claim that every optional plugin is active in one server. Verification records document exercised behavior. Earlier Drive exports remain historical snapshots.

The Workflows tool adapter exposes `workflow.status_and_next`, `workflow.catalog`, `workflow.assignment`, `workflow.process`, `workflow.begin` and `workflow.extend_limit`. Session catalogs filter tools through fixed workflow grants; session activation owns the start marker, so session grants exclude interactive `workflow.begin`.

The checked-in SVG/PNG and DOT panels show their 2026-09-16 dependency snapshot and should not be used as the current count. `current-dependencies.json` is the generated inventory for current declarations, including the separate Runner HTTP connection.

The checked-in [renderer](../../scripts/render-dependencies.mjs) uses the Graphviz `dot` engine through `@viz-js/viz`, combines five SVG panels with the adapter rows, and converts the result to a 2800 × 4905 PNG with Sharp. It uses the bundled dependency runtime; `MERV_RENDER_NODE_MODULES` can name another directory containing those existing packages. The checked-in outputs were visually checked for their historical snapshot.

Regenerate the inventory and images with:

```sh
npm run docs:architecture
node scripts/render-dependencies.mjs
```

Regenerate or update the DOT panels before presenting new SVG/PNG exports as current. The renderer checks their providers, Cordis edges and HTTP connections against the generated inventory.

Scope now owns tool grants and session-policy registration through `scope.toolPolicy`. Access is an internal Scope module, not a separate plugin. Tools requires only Scope; External Mounts requires Tools and Scope and owns upstream credential resolution internally. See the [configuration migration](../../packages/scope/README.md).
