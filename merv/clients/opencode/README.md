# OpenCode

## Hosted setup

```bash
opencode plugin 'github:rapidreview-io/Merv#merv-client' --global
opencode mcp auth merv
```

The plugin registers Merv's hosted OAuth MCP server, the hosted skill catalog,
and the reviewer subagents. OpenCode refreshes content-versioned skills when a
session starts. Rerun the install command when Merv announces an adapter update.

On a remote machine over SSH, the browser's sign-in callback cannot reach
OpenCode's loopback listener. Pair with the device grant instead — run
`curl -fsSL https://rapidreview.io/merv/pair_mcp.py -o /tmp/pair_mcp.py &&
python3 /tmp/pair_mcp.py` on that machine, approve the printed code in any
signed-in browser, and restart OpenCode. See
[Remote machines](https://github.com/rapidreview-io/Merv/blob/main/merv/docs/AUTH.md#remote-machines)
for details and the SSH port-forward fallback.

For a headless process that cannot open a browser, use the static-key example
in [Authentication](https://github.com/rapidreview-io/Merv/blob/main/merv/docs/AUTH.md#when-a-static-key-is-still-required).
