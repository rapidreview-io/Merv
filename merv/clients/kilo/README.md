# Kilo Code adapter

The generated `merv-client` branch is an installable Kilo server plugin. It
registers Merv's hosted HTTP MCP endpoint, the hosted remote-skill catalog, and
the four read-only reviewer subagents in Kilo's effective configuration.

```bash
kilo plugin 'github:rapidreview-io/Merv#merv-client' --global
kilo mcp auth merv
```

No repository checkout or Merv key is required. Kilo checks the catalog at the
start of each session. Use `/reload` to pick up a published skill change in an
already-running session.

`build_catalog.py` builds the catalog from the canonical `merv/skills/` tree.
Each entry carries a content-derived version; Kilo downloads a changed version
into a staging directory and keeps its prior cached copy if that download
fails.
