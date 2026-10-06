# @merv/api

Merv's front door. The package holds two plugins: `@merv/api/tools-plugin` (config row `tools`) injects `scope` and provides `tools`, the registry every plugin registers its tools in; `@merv/api` (config row `api`) injects `scope`, `tools` and `identity` and provides `api`, the HTTP server. The server answers `/health`, `/auth/config`, `/tools` and `/mcp` itself, and other plugins mount their own routes on it. Read-only tools run in a State snapshot when State is loaded.

## Where it sits

```mermaid
flowchart LR
  subgraph peopleLayer["People & agents"]
    browser["Browser person"]
    workerAgent["Worker agent"]
    mcpClient["External MCP client"]
  end
  subgraph foundationsLayer["Foundations"]
    api["API<br/><small>HTTP server and tool registry</small>"]:::self
    identity["Identity"]
    scope["Scope"]
    sessions["Sessions"]
    secrets["Secrets"]
    ui["UI"]
    pi["Pi"]
  end
  subgraph researchLayer["Research logic"]
    researchLogic["Tasks, Experiments, Knowledge,<br/>Reflections, Research, Paper"]
  end
  browser -- "HTTP /ui and routes" --> api
  workerAgent -- "HTTP /mcp" --> api
  mcpClient -- "HTTP /mcp" --> api
  api -- "injects" --> identity
  api -- "injects" --> scope
  sessions -- "mounts /sessions" --> api
  secrets -- "mounts /secrets, /hf" --> api
  ui -- "mounts /ui" --> api
  pi -- "calls tools" --> api
  researchLogic -- "registers tools" --> api
  classDef self fill:#2f6feb,color:#fff,stroke:#1f4fb0
```

People and agents reach Merv only through the API: Identity verifies a browser's token and Scope decides what each caller may do. Plugins plug in by mounting routes and registering tools, and the same registry serves `/mcp`, `/tools` and Pi's in-process calls.

## Surface

- HTTP: `/health` and `/auth/config` (public), `/tools`, and the MCP endpoint `/mcp`.
- `ctx.api`: `mount(prefix, handler)`, `credential(namespace, …)`, `start`, `stop`.
- `ctx.tools`: `register`, `list`, `call`, `invoke`, `registerSessionPolicy`, `registerCallerRules`, `contributeInstructions`, `contributeContext`.
