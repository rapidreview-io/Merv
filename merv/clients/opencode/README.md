# OpenCode

## Hosted setup

```bash
opencode plugin 'github:rapidreview-io/Merv#merv-client' --global
opencode mcp auth merv
```

The plugin registers Merv's hosted OAuth MCP server, the hosted skill catalog,
and the reviewer subagents. OpenCode refreshes content-versioned skills when a
session starts. Rerun the install command when Merv announces an adapter update.

On a remote machine over SSH, sign in as usual and choose **On another
machine** when the consent page asks where the agent is running — it hands
you one command to run on that machine. See
[Remote machines](https://github.com/rapidreview-io/Merv/blob/main/merv/docs/AUTH.md#remote-machines).

For a headless process that cannot open a browser, use the static-key example
in [Authentication](https://github.com/rapidreview-io/Merv/blob/main/merv/docs/AUTH.md#when-a-static-key-is-still-required).
