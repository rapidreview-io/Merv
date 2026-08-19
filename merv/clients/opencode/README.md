# OpenCode

## Hosted setup

```bash
opencode plugin 'github:rapidreview-io/Merv#merv-client' --global
opencode mcp auth merv
```

The plugin registers Merv's hosted OAuth MCP server, the hosted skill catalog,
and the reviewer subagents. OpenCode refreshes content-versioned skills when a
session starts. Rerun the install command when Merv announces an adapter update.

On a remote machine over SSH, the browser's sign-in callback must reach
OpenCode's listener at `127.0.0.1:19876` on that machine. Connect with
`ssh -o ExitOnForwardFailure=yes -L 19876:127.0.0.1:19876 user@host` from the
laptop whose browser will approve, then run `opencode mcp auth merv` inside
that session and open the printed URL locally. See
[Remote machines](https://github.com/rapidreview-io/Merv/blob/main/merv/docs/AUTH.md#remote-machines).

For a headless process that cannot open a browser, use the static-key example
in [Authentication](https://github.com/rapidreview-io/Merv/blob/main/merv/docs/AUTH.md#when-a-static-key-is-still-required).
