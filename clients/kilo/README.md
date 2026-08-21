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

On a remote machine over SSH, the browser's sign-in callback cannot reach
Kilo's loopback listener. Pair with the device grant instead — run
`curl -fsSL https://rapidreview.io/merv/pair_mcp.py -o /tmp/pair_mcp.py &&
python3 /tmp/pair_mcp.py` on that machine, approve the printed code in any
signed-in browser, and restart Kilo. See
[Remote machines](https://github.com/rapidreview-io/Merv/blob/main/merv/docs/AUTH.md#remote-machines)
for details and the SSH port-forward fallback.

`build_catalog.py` builds the catalog from the canonical `merv/skills/` tree.
Each entry carries a content-derived version; Kilo downloads a changed version
into a staging directory and keeps its prior cached copy if that download
fails.
