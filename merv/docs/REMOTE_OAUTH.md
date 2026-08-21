# Browserless remote OAuth

`merv-mcp` gives remote machines a client-neutral OAuth path. The user approves
a short device code in any browser; the browser never redirects to the VM and
the user never creates or copies an API key.

## Install and sign in

Install Merv with Python 3.11 or newer:

```bash
python3 -m pip install 'git+https://github.com/rapidreview-io/Merv.git#subdirectory=merv'
merv-mcp login
```

The command prints a verification link and short code. Open the link on any
device, sign in, choose the project scope, and approve. The VM polls Merv for
completion and stores the rotating OAuth grant in `~/.merv/oauth.json` with
owner-only permissions. Run `merv-mcp status` to inspect it or `merv-mcp
logout` to remove it from that machine.

For a development or self-hosted brain, pass its full MCP resource URL to both
commands:

```bash
merv-mcp login --server-url https://merv.example/mcp
merv-mcp serve --server-url https://merv.example/mcp
```

## Connect any STDIO MCP client

Configure a local STDIO server whose command is `merv-mcp` and whose first
argument is `serve`. The common JSON form used by Claude Code, Cursor, Kilo,
and several other clients is:

```json
{
  "mcpServers": {
    "merv": {
      "command": "merv-mcp",
      "args": ["serve"]
    }
  }
}
```

Codex uses the equivalent TOML:

```toml
[mcp_servers.merv]
command = "merv-mcp"
args = ["serve"]
```

Use the executable's absolute path when the client has a restricted `PATH`.
If an installed Merv plugin already defines a remote server named `merv`,
replace that entry or name this one `merv-device`; do not run both entries.

The bridge forwards JSON-RPC over STDIO to Merv's Streamable HTTP endpoint. It
preserves MCP session and protocol headers, streams SSE progress messages,
refreshes the OAuth grant before expiry, and retries once after an unexpected
401. The access and refresh tokens remain implementation details in the local
credential store; they are never placed in MCP configuration or environment
variables.

## Which path to use

- On a laptop where the client's browser callback works, keep using the
  client's native Merv OAuth login.
- On an SSH VM, container shell, or remote workstation, use `merv-mcp login`
  plus the STDIO entry above. This works for Codex, Claude Code, Cursor, Kilo,
  OpenCode, and any other client that can launch a STDIO MCP server.
- Kilo and OpenCode may alternatively use `clients/pair_mcp.py`, which writes
  the same OAuth grant into those clients' native token stores. The bridge is
  preferred for one setup shared across multiple clients.
- CI and truly unattended services still need a separately provisioned
  machine credential because device authorization requires a human approval.

## Security properties

- Device codes expire after ten minutes and the server rate-limits creation,
  polling, and invalid user-code attempts.
- OAuth endpoints discovered by the bridge must remain on the exact Merv
  origin, preventing discovery metadata from redirecting credentials elsewhere.
- Non-loopback servers must use HTTPS. HTTP is accepted only for an explicit
  loopback development server.
- The credential directory is mode `0700` and its JSON store is mode `0600` on
  POSIX. Symlinked, non-regular, or group/world-readable stores are rejected.
- Merv access tokens remain audience-bound to the configured `/mcp` resource;
  refresh-token rotation and server-side revocation are unchanged.
