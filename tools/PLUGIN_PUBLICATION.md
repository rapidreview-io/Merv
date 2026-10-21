# Publishing the small public plugin repository

Canonical plugin files stay in `clients/`. The destination is the dedicated public
`rapidreview-io/merv-plugins` repository. No application build, Python client package,
backend source or source Git history is published.

Export a committed source revision into a **new** directory:

```sh
python3 tools/export_plugins.py --revision HEAD --out /tmp/merv-plugins-release
```

The output has exactly 19 files: both marketplace manifests, the canonical manifest,
two plugin manifests, two MCP configs, eight skills, canonical README, LICENSE, NOTICE,
and generated PROVENANCE.json. The explicit allowlist is in `tools/export_plugins.py`.
Git symlink/submodule source entries are refused. Uncommitted files, `.env`, extra files,
backend files and Git history cannot enter the export. The output records the exact source
commit, plugin version and SHA-256 of every copied file. It does not transform user text;
update the canonical README/skills through their owning author before the final export.

Run the focused checks with:

```sh
python3 -m unittest discover -s tools -p 'test_export_plugins.py'
```

The exporter validates local marketplace paths, required manifests and skills, matching
versions, skill parity and exact HTTPS MCP configuration with no headers, local commands,
environment or extra servers. It refuses an existing destination rather than merging files.

## Parent's initial/local publication

The parent creates the dedicated public repository and controls publication. An exported
fresh directory can be initialized as a new Git repository and pushed using the parent's
existing `gh auth setup-git` authentication; the exporter itself never initializes Git,
creates a remote, requests credentials or pushes anything. This preserves no private
source history. Initialize the destination's `main` branch during that first publication.
For later local updates, export to a fresh directory, review the diff against a checkout of
that public repository, copy only the exported files, and commit/push normally (no force).
Keep publication access separate from end-user browser OAuth.

## Optional automated updates

`.github/workflows/publish-client-bundle.yml` replaces the old Python client/merv-client
force-push pipeline. It runs only on manual dispatch or a `clients-vVERSION` tag; tags must
match the canonical manifest version. It runs the focused tests and exporter, and uploads
an artifact including hidden marketplace/plugin files. It never runs the app build/full suite.

To enable cross-repository publication, configure source-repository Actions secret
`MERV_PLUGINS_PUBLISH_TOKEN` with a fine-grained publication credential limited to
`rapidreview-io/merv-plugins` and Contents read/write. The source workflow's `GITHUB_TOKEN`
is read-only and is not used for cross-repository writes. Restrict source tag creation and
manual workflow execution to maintainers; apply the destination's normal branch rules.
Do not put tokens into command-line URLs, source files or the exported artifact.

Without that explicit secret, export/verification/artifact creation still succeeds and the
workflow summary clearly reports **publication skipped**. The parent's local authenticated
push is not blocked by optional CI setup.

With the secret configured, the workflow checks out the destination's existing `main`,
mirrors only the export (preserving `.git`), and makes a normal non-force push. The destination
is entirely generated: unrelated files there would be removed by this mirror. Keep custom
user docs in canonical `clients/`, not as destination-only edits. Concurrent external pushes
fail normally rather than being overwritten. Repeated publication of identical input is a
no-op. Source private commit identifiers appear in PROVENANCE.json intentionally; no source
repository contents or history are copied by that reference.
