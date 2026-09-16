# Upload an artifact from a local file

`artifact-upload` saves agents from copying file contents or base64 into tool arguments. The CLI reads the file locally, calls the existing `artifact.create` MCP tool, and prints a compact JSON receipt containing the artifact ID, metadata, SHA-256 hash and byte count. It checks the returned hash and byte count against the uploaded bytes before reporting success.

Make the existing Merv key available in an environment variable, such as `MERV_KEY`, then run:

```sh
npm run cli -- artifact-upload \
  --url http://127.0.0.1:3081 \
  --file ./results.json \
  --token-env MERV_KEY \
  --title "Retained experiment results"
```

Use `--project PROJECT_ID` when the credential requires an explicit project selection. `--media-type TYPE` overrides the inferred media type; otherwise the CLI recognizes common document/image extensions and falls back to `application/octet-stream`. The default title is the file's basename. The receipt's artifact ID can then be attached to an experiment, task delivery or another existing evidence tool.

The key is read from the named environment variable rather than passed in command arguments. A live agent-session credential works only when its assignment permits `artifact.create`; normal project and role checks still apply. The server receives the bytes through MCP, not a path it can open on the agent's machine.

Limits:

- The file must be regular, nonempty, and at most **2,000,000 bytes**. Binary files are supported.
- Use an HTTPS server URL, or HTTP on `localhost`, `127.0.0.1`, or `[::1]`. Credentials, query parameters and fragments in the URL are rejected; redirects are not followed. The CLI connects to `/mcp` on that server.
- File/base64 contents are not printed in the successful receipt. Only the receipt needs to enter the agent's context.
- The CLI **does not automatically retry** an upload without a verified receipt. An interrupted response may follow a successful server write. Check retained artifacts before deciding to repeat it: `artifact.create` does not deduplicate repeated uploads.

This helper uses the existing artifact system. Remote compute, large datasets and model storage remain delegated to Merv Sandboxes.
