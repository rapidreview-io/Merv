# OpenCode

## Hosted setup

```bash
opencode plugin 'github:rapidreview-io/Merv#merv-client' --global
opencode mcp auth merv
```

The plugin registers Merv's hosted OAuth MCP server, the hosted skill catalog,
and the reviewer subagents. OpenCode refreshes content-versioned skills when a
session starts. Rerun the install command when Merv announces an adapter update.

On a machine with no browser (a VM over SSH, a container, CI), mint a project
key and pass it as a bearer header instead of signing in. See
[Machines with no browser](https://github.com/rapidreview-io/Merv/blob/main/merv/docs/AUTH.md#machines-with-no-browser).
