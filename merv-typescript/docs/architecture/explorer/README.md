# Interactive architecture sketchbook

Open [index.html](index.html) in a browser. It is a standalone page: no framework, network requests, backend, or browser runtime dependencies. The pencil appearance is editable HTML, CSS and SVG.

Hover or keyboard-focus a plugin to trace its direct requirements and consumers. Click to pin the selection and inspect its purpose, dependencies, adapters and exposed tools. Relationship buttons follow the next plugin. Click a group heading for its aggregated connections, or the front-door adapter badge for all transport adapters. Escape or **Whole map** clears the selection. Narrow screens provide **View details** / **Back to map** shortcuts.

A URL fragment preserves the selected plugin on reload. Solid arrows point from a dependent plugin to its required service; dashed arrows are network connections. Group-level arrows combine relationships, while the detail panel names every exact dependency. Adapters are represented in the front-door cluster and listed individually in the panel.

The **Dependency DAG** page shows the complete graph with one card per plugin and one arrow per declared dependency. The 2026-09-16 full view has 56 plugins and 144 edges (138 required, six optional), all expanded; shared services are never replicated. **Hide adapters** removes tool, UI and API adapter cards and their incident edges, then lays out and fits the remaining 25 service plugins and 82 dependencies. Press it again to restore the full graph. Search and jump options follow the visible graph; hiding a selected adapter clears that selection. This is a diagram filter, not a runtime plugin unload. Each arrow points downward from a consumer to a used service: solid arrows are required and dashed arrows are optional integrations. Solid cards are service providers and dashed cards are adapters. Runner is a separate-machine node with no injected server dependencies. HTTP/MCP connections remain in the detail panel.

Drag the background, scroll, or use keyboard arrows on the focused canvas to pan. Use **Fit DAG** for the overview, **100%** for readable cards, and the zoom buttons or Ctrl-scroll/trackpad pinch to zoom. **Find Knowledge**, **Find UI**, the searchable picker and **Center selected** move to a plugin at a readable scale. Search highlights matches without removing nodes. Hover or focus highlights direct requirements and consumers; click opens the shared detail panel. **Clear highlight** restores the complete overview styling.

The deterministic layered layout runs locally with no library or network request. It rejects cyclic dependency data, assigns each plugin exactly one position, and uses invisible routing points for long arrows. Routing points are not plugin nodes. Current links use `#dag/knowledge`; previous `#tree/...` links redirect to the DAG view. Both pages share the same source inventory and refresh command. Research requires State, Scope and Workflows; its Paper, Reflections, Knowledge and Consolidation edges are optional. Removing one keeps Research active, while operations that actually need it report a specific blocker. Historical records and existing child IDs are retained; absence never means empty or approved evidence.

## Keep it current

From the TypeScript project root:

```sh
npm run docs:architecture
```

This extracts Cordis `inject` declarations and native tool definitions from source, then regenerates `data.json` and the self-contained `index.html`. Reload the browser after regeneration. This is a source snapshot, not a live health or activation monitor. Remote mounted tool catalogs are discovered at runtime and are not included in the static native catalog.

Edit these small source files:

| File                                        | Purpose                                             |
| ------------------------------------------- | --------------------------------------------------- |
| `notes.json`                                | Group membership, readable names, and explanations  |
| `shell.html`                                | Page structure                                      |
| `style.css`                                 | Notebook appearance and responsive layout           |
| `app.js`                                    | Selection, detail panels and SVG routing            |
| `dag.js`                                    | DAG layout, unique nodes, pan/zoom and highlighting |
| `../../../scripts/architecture-explorer.ts` | Source extraction and standalone build              |

Do not edit generated `index.html` or `data.json` directly. Newly discovered providers appear in a **New providers** group until assigned in `notes.json`.
