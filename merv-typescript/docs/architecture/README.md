# Current plugin dependencies

Open the [interactive sketchbook](explorer/index.html) to hover over dependencies, select plugins, follow their consumers, and inspect exposed tools. Its editable sources and refresh instructions are in the [explorer guide](explorer/README.md). `npm run docs:architecture` regenerates it alongside the inventory.

The JSON and Mermaid sources are extracted from current `inject` declarations by `npm run docs:architecture`. The checked-in Graphviz SVG/PNG and five DOT panels are a historical 2026-09-16 layout until regenerated; use `current-dependencies.json` for the current inventory. The panels cover domain providers, transport, research programs, Paper, Sessions, Code and the independent machine Runner.

Production storage selects PostgreSQL for State and S3/R2 for Blobs without adding provider dependencies. The legacy migration can additionally configure the temporary `legacy-history-ui` entry from `src/legacy-history-ui.ts`, requiring State, Scope and UI. It exposes human-only historical reads through the existing `ui.read` tool and links retained files to ordinary Artifacts. This migration-only entry is outside the default composition and the package diagrams below; it adds no workflow engine, service capability or agent tool.

The 2026-09-22 inventory has 58 plugin entrypoints: 26 service providers, 15 tool adapters, 15 UI adapters and two API adapters. It records 152 direct Cordis dependencies, including 13 optional integrations. There are 57 server entrypoints and one independent machine entrypoint. The default server configuration selects 50 entries; API-only selection uses 37. Optional bindings include Experiments, Knowledge and Tasks → Code Research, and Research → its stage providers. The retired Consolidation plugin is absent.

Some providers repeat as reference blocks across panels; each is one shared provider. Solid arrows mean the source plugin requires the target service through Cordis. Dashed arrows mark optional integrations. The dotted Runner-to-API arrow is an HTTP connection and is explicitly excluded from the Cordis dependency count. These arrows do not guarantee remote health. Nisa and Sandboxes remain external MCP services reached through Mounts.

Task types own context recipes directly. There are no task-context adapter plugins. Reviews depends on Domain Events for revocation recovery; Tasks depends on Context Builder for recipe registration and package assembly. Workflows owns assignment leases; Agent Sessions binds agents to their current execution. The outer Research program advances explicitly and does not launch agents.

Claims requires only State and Scope. It retains project research statements, status/confidence, revision checks and mutation receipts. Its tool adapter exposes `claim.create`, `claim.list`, `claim.update`; its UI adapter adds a Claims page. Claim status is a research fact, not a work lifecycle. There is no Claims dependency on Workflows or Artifacts.

Experiments requires State, Scope, Claims, Artifacts, Workflows, Reviews, Context Builder and Paper, with optional Code integration. It owns attempts, exact evidence rounds, metrics exhibits, four node recipes and review routing. Code provides exact historical workspace/commit capture references for the versioned Git execution path. Its adapters expose seven experiment tools and the Experiments page. Recovery uses the existing generic Workflows/Sessions/Reviews contracts; Experiments adds no direct Domain Events or Sessions dependency.

Knowledge requires State, Scope, Claims, Tasks, Experiments, Artifacts and Reviews, with optional Code integration. It composes project records and scoped reference metadata through public domain contracts. Its tools are `project.records` and `project.references`; its UI adapter adds Research records. Current project intent, terminal work, claims, code proposals and exact captures can be inspected without creating a Reflection publication or reading artifact bytes. Workflow gates and next actions remain in Workflows; Knowledge has no direct Workflows dependency.

Paper requires State, Scope and Artifacts. It stores documents, citations, immutable proposed edits and reviewed revisions. It has no Workflows, Context Builder or Knowledge dependency. Experiment and reflection owners submit and accept changes through their existing scientific reviews.

Reflections requires State, Scope, Artifacts, Paper, Workflows, Reviews and Context Builder. It has no Knowledge or Research dependency. It starts five independent lens workflows over live project research, assembles compact assignment context, and routes independent review. Workflows pauses new task/experiment creation until approval; existing work continues. Research supplies current research-linked evidence permissions through an optional Workflows callback. Removing Research or Knowledge leaves reflection assignments, leases and submissions active. Knowledge removal withdraws the extra research-evidence read resolver while Research stays active; those reads resume when Knowledge is rebound. This does not make Reflections independent of its own required Paper provider. Approval retains immutable report, change specification and lens provenance. Review contributor exclusions prevent lens authors from reviewing their own synthesis.

Consolidation is now an ordinary Git Task injected by Research after a reflection is independently approved. Tasks owns delivery and review; Code Research owns captures, repository admission and publication. The dedicated Consolidation plugin and its candidate-freeze API are retired. Its database and Git facts remain retained.

Research requires State, Scope and Workflows. Domain Events, Paper, Reflections, Knowledge, Tasks, Experiments, Artifacts and Code Research bind as optional providers. Current `research@6` cycles move through definition, selected research and independent reflection; when accepted code is missing from main, Research injects a Git Task for integration and waits for its acceptance and publication. It can complete without that task when main already holds the code. Missing providers block only the operations that use them, and a replaced provider cannot commit an in-flight result. Historical cycles that require the retired Consolidation workflow report `research_consolidation_retired` at its handoff while retaining their stored records. See [Research cycles](../RESEARCH.md).

Agent Sessions owns continuing agent identity and session continuity, while Workflows owns assignment leases and Scope enforces security actors. Existing execution IDs stay fixed for evidence and stale-call fencing. Explicit assignment changes add no dependency arrows. See [agent continuity](../AGENT_CONTINUITY.md).

Scope owns the project Introduction and its revision/retry receipts, exposed through `project.context.update`. This adds no provider. Tasks retains the Introduction captured at lease offer in its existing immutable lease receipt, while ordinary newly built task context reads the current Introduction.

Sessions requires State, Scope, Workflows, and Domain Events. Program registration hooks provide domain ownership and recovery without adding direct Sessions-to-Tasks or Sessions-to-Reviews dependencies. The `sessions-api` adapter requires Sessions and API; its HTTP controls do not add MCP tools. The optional `sessions-ui` adapter requires Sessions and UI, and publishes the project dispatch/session page.

The core Code provider requires State and Scope. Code Research requires Code, State, Scope, Sessions, Artifacts, Workflows and Domain Events; Reviews and Sandboxes bind optionally. Its tools expose checkpoints, repository controls and publication controls, and its HTTP adapter connects the Runner to durable commands and receipts. Code Research seals immutable proposal manifests and supports the ordinary Git-unit review and publication path used by Tasks. See [the Code contract](../CODE_OPERATIONS.md).

Reviews owns the generic `review.submit` tool and routes it to exactly one disposable domain owner. Tasks, Experiments and Reflections register their domain callbacks through their existing Reviews dependencies. Removing an owner withdraws its callback. This adds no Cordis dependency from Reviews to Tasks or future domain programs; callback registration is not an extra graph arrow.

Runner provides `runner` and declares `inject: []`. It runs in a separate machine Cordis context, calls server session and Code command controls over HTTP, and supervises local agent processes. Its private local SQLite launch ledger is independent of the server State plugin. It adds no MCP tools, server inject edges, or default server entries. See the [Runner process foundation](../../packages/runner/README.md) for ownership and recovery guarantees and their limits.

These files represent current declarations, not a claim that every optional plugin is active in one server. Verification records document exercised behavior. Earlier Drive exports remain historical snapshots.

The Workflows tool adapter exposes `workflow.status_and_next`, `workflow.assignment`, and `workflow.begin`. Session catalogs filter tools through fixed workflow grants; session activation owns the start marker, so session grants exclude interactive `workflow.begin`.

The checked-in SVG/PNG and DOT panels show their 2026-09-16 dependency snapshot and should not be used as the current count. `current-dependencies.json` is the generated inventory for current declarations, including the separate Runner HTTP connection.

The checked-in [renderer](../../scripts/render-dependencies.mjs) uses the Graphviz `dot` engine through `@viz-js/viz`, combines five SVG panels with the adapter rows, and converts the result to a 2800 × 4905 PNG with Sharp. It uses the bundled dependency runtime; `MERV_RENDER_NODE_MODULES` can name another directory containing those existing packages. The checked-in outputs were visually checked for their historical snapshot.

Regenerate the inventory and images with:

```sh
npm run docs:architecture
node scripts/render-dependencies.mjs
```

Regenerate or update the DOT panels before presenting new SVG/PNG exports as current. The renderer checks their providers, Cordis edges and HTTP connections against the generated inventory.

Scope now owns tool grants and session-policy registration through `scope.toolPolicy`. Access is an internal Scope module, not a separate plugin. Tools requires only Scope; External Mounts requires Tools and Scope and owns upstream credential resolution internally. See the [configuration migration](../../packages/scope/README.md).
