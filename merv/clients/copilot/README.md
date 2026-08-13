# GitHub Copilot CLI

## Hosted setup

```bash
copilot plugin marketplace add rapidreview-io/Merv
copilot plugin install merv@rapidreview
```

Start Copilot and run `/mcp auth merv`. Approve **All my projects** in the
browser.

Copilot CLI reads Merv's existing Claude-compatible marketplace, plugin,
skills, agents, and `.mcp.json` directly. No separate Copilot package is
maintained. Update with:

```bash
copilot plugin update merv@rapidreview
```
