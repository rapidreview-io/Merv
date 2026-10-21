# Upload an artifact from a local file

A connected agent uses `artifact.write` with a top-level `projectId` and nested
action arguments. For a finished on-disk file, up to **512 MiB**:

1. Measure its exact byte count (`wc -c < FILE`) and SHA-256 (`shasum -a 256 FILE`).
2. Call `artifact.write` with `{"action":"upload_begin","upload_begin":{"title":"Results","size":123,"sha256":"<64 lowercase hex characters>","mediaType":"application/json","requestId":"results-1"}}`, substituting the measured values.
3. PUT the unchanged file to `parts[0].url`, sending exactly `parts[0].headers`.
   Empty parts or HTTP 412 mean the bytes are already stored. URLs last one hour;
   `upload_resume` with the `uploadId` gets a fresh URL.
4. Call `artifact.write` with `{"action":"upload_complete","upload_complete":{"uploadId":"<upload id>"}}`.
   The server verifies the bytes and returns an immutable artifact to attach as evidence.

Reuse the same `requestId` and input after an uncertain begin; completion is safe
to retry with the same upload ID. `artifact.read` (`storage`) reports whether the
blob store can sign uploads. Read metadata with `get`, content with `content`, and
private download URLs with `download`, each under its matching action object.
For inline content up to **2,000,000 bytes**, use `artifact.write` (`create`) with
`encoding: "utf8"` for text or `"base64"` for binary and a stable `requestId`.

## Small-file CLI compatibility

The `artifact-upload` CLI still calls the one-release `artifact.create` alias. It
reads a regular, nonempty local file of at most 2,000,000 bytes and prints a compact
receipt after verifying the returned hash and size. It sends the bytes, not a path.

```sh
npm run cli -- artifact-upload \
  --url https://experiments.rapidreview.io \
  --file ./results.json \
  --token-env MERV_KEY \
  --title "Retained experiment results"
```

This manual-key path reads an existing key from the named environment variable;
do not obtain it by reading the connector's private store. Use `--project PROJECT_ID`
when needed. `--media-type TYPE` overrides inference; the title defaults to the basename.
HTTPS is required except on loopback. Redirects are refused. The CLI supplies no
request ID and does not automatically retry: check retained artifacts before
repeating an interrupted upload. Worker credentials must grant its alias;
normal project and role checks still apply.
