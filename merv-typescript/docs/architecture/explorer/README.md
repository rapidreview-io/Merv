# Interactive architecture sketchbook

Open [index.html](index.html) in a browser. It is a standalone page: no framework, network requests, backend, or browser runtime dependencies. The pencil appearance is editable HTML, CSS and SVG.

The default **Hierarchy** view places 23 core plugins in eight responsibility layers, with the composition root above them and 46 adapters/execution bindings beside the stack. This is a working design proposal: actual edges come from Cordis declarations, not invented layer relationships. Every plugin has exactly one placement, checked by the generator. The root is application assembly (`src/app.ts` plus CLI/configuration), not another plugin.

Lines are hidden in every view until a plugin is hovered, keyboard-focused or selected. Only incident relationships appear; clicking pins them and Escape or Clear selection clears them.

Hover or keyboard-focus a plugin to trace its direct requirements and consumers. Click to pin the selection and inspect its purpose, dependencies, adapters and exposed tools. Relationship buttons follow the next plugin. Click a group heading for its aggregated connections, or the front-door adapter badge for all transport adapters. Escape or **Whole map** clears the selection. Narrow screens provide **View details** / **Back to map** shortcuts.

A URL fragment preserves the selected plugin on reload. Solid arrows point from a dependent plugin to its required service; dashed arrows are network connections. Group-level arrows combine relationships, while the detail panel names every exact dependency. Adapters are represented in the front-door cluster and listed individually in the panel.

The **Dependency DAG** page places one card per plugin using dependency depth. All nodes remain present, but arrows appear only for the hovered or selected plugin. The current full view has 69 plugins and 193 edges (170 required, 23 optional), all expanded; shared services are never replicated. **Hide adapters** removes tool, UI and API adapter cards and their incident edges, then lays out and fits the remaining 31 service plugins and 113 dependencies (90 required, 23 optional). Press it again to restore the full graph. Search and jump options follow the visible graph; hiding a selected adapter clears that selection. This is a diagram filter, not a runtime plugin unload. Each arrow points downward from a consumer to a used service: solid arrows are required and dashed arrows are optional integrations. Solid cards are service providers and dashed cards are adapters. Runner is a separate-machine node with no injected server dependencies. HTTP/MCP connections remain in the detail panel.

Drag the background, scroll, or use keyboard arrows on the focused canvas to pan. Use **Fit DAG** for the overview, **100%** for readable cards, and the zoom buttons or Ctrl-scroll/trackpad pinch to zoom. **Find Knowledge**, **Find UI**, the searchable picker and **Center selected** move to a plugin at a readable scale. Search highlights matches without removing nodes. Hover or focus highlights direct requirements and consumers; click opens the shared detail panel. **Clear highlight** restores the complete overview styling.

The deterministic layered layout runs locally with no library or network request. It rejects cyclic dependency data, assigns each plugin exactly one position, and uses invisible routing points for long arrows. Routing points are not plugin nodes. Current links use `#dag/knowledge`; previous `#tree/...` links redirect to the DAG view. All three views share the same source inventory and refresh command. Research requires State, Scope and Workflows; its Domain Events, Paper, Reflections, Tasks, Experiments, Artifacts and Code Research edges are optional. Removing one keeps Research active, while operations that actually need it report a specific blocker. Digests read selected tasks and experiments directly, without Knowledge. Integration after approved reflection uses an ordinary Git Task and Code Research when accepted code is missing from main; the dedicated Consolidation plugin is retired. Historical records and existing child IDs are retained; absence never means empty or approved evidence.

## Keep it current

From the TypeScript project root:

```sh
npm run docs:architecture
```

This scans package sources and top-level application sources, including the optional legacy-history adapter. It extracts Cordis `inject` declarations and native tool definitions from source, then regenerates `data.json` and the self-contained `index.html`. Reload the browser after regeneration. This is a source snapshot, not a live health or activation monitor. Remote mounted tool catalogs are discovered at runtime and are not included in the static native catalog.

Edit these small source files:

| File                                        | Purpose                                             |
| ------------------------------------------- | --------------------------------------------------- |
| `notes.json`                                | Groups, hierarchy placement, names and explanations |
| `shell.html`                                | Page structure                                      |
| `style.css`                                 | Notebook appearance and responsive layout           |
| `app.js`                                    | Selection, detail panels and SVG routing            |
| `hierarchy.js`                              | Responsibility layers and relationship tracing      |
| `dag.js`                                    | DAG layout, unique nodes, pan/zoom and highlighting |
| `../../../scripts/architecture-explorer.ts` | Source extraction and standalone build              |

Do not edit generated `index.html` or `data.json` directly. Newly discovered providers appear in a **New providers** group until assigned in `notes.json`.

## Proposed layering rules

- Core capabilities depend on lower layers. Same-layer collaboration must be explicit; the current declared peer edge is Code Research → Reviews (optional).
- Tools, HTTP and UI adapters expose capabilities at the system boundary. The shared Tools registry is a reusable core capability, distinct from its domain adapters.
- The composition root assembles plugins; Research owns research decisions. Assembly code must not accumulate domain policy.
- The hierarchy check covers declared Cordis injections only. It does not certify import, callback or database-access boundaries. Sandboxes currently combines an upstream client with session/evidence/API integration, a boundary to examine before enforcing this design.

`notes.json` owns the proposed placement. The generator rejects missing, duplicate or unknown plugin placements and reports upward/peer core dependencies without hiding them. Updating the view does not refactor the backend.
