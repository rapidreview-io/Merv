# Qwen Code

## Hosted setup

```bash
qwen extensions install rapidreview-io/Merv --ref=merv-client
```

Start Qwen, open `/mcp`, and sign in to Merv. Approve **All my projects** in
the browser.

The generated `merv-client` branch contains Qwen's native extension manifest,
the canonical Merv skills and reviewer agents, and the hosted OAuth MCP
connection. Qwen prompts when the tracked branch changes. Update immediately
with:

```bash
qwen extensions update merv
```
