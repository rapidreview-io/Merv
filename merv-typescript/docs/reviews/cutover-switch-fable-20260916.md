# Cutover script review — local disposition

Fable reviewed source only; it did not execute the scripts. Before execution, the owner added forced container recreation and checked the three target environment values plus start time, checked every available download sample, normalized and bounded both asset paths, and restricted the Caddy replacement to the verified experiments host block.

Finding 2 does not describe an actual missing projects comparison: `reconcile()` already compares all project content hashes, included under `nativeRowsAndHashes`. Its `projects` field is a map of per-project counts, not another pass/fail status. The script now asserts the exact reconciliation keys and map shape. The download checker already throws on any failed sample; its caller now independently verifies all sample statuses too. Compose already declares the environment file, and both the pre-switch and rollback image are deliberately the same UI-accepted image; only the schema/source/prefix changes. Explicit runtime guards remove that ambiguity.

Review text below is unmodified. Later execution evidence belongs in the cutover record.

---

## Blockers

**Stage script (merv-final-stage-vm.py)**

1. **Env changes may never reach the container (wrong-state assumption / silent wrong-schema run).** The script asserts `merv-typescript-control-1` is *already running* the target image, then rewrites `/etc/merv/typescript.env` and runs `docker compose up -d` with the *same* image. If the compose file doesn't declare that env file as `env_file` config (or if it's a bind-mounted file read only at boot), compose sees no change and does **not** recreate the container. All subsequent checks (ready log, plugins, counts) would then pass against the container still running the *old* env — i.e., the old `MERV_TS_DB_SCHEMA`/`MERV_BLOB_PREFIX` — and you'd publicly cut over to the staging/rehearsal schema. There is no guard verifying the container was actually recreated (e.g., compare `StartedAt`/`Config.Env` after deploy). The rollback path (`install_env(old);deploy()`) has the same flaw and also re-deploys the **new image**, not a rollback.

2. **`projects` excluded from reconciliation.** `all(... if key!='projects')` means a projects-table mismatch in the reconcile report is ignored. The later hardcoded `counts['projects']==30` is a weaker substitute (count equality ≠ content match). Data-loss guard hole.

3. **Download-receipt guard uses `any`, not `all`.** One passing sample with `kind=='ordinary'` satisfies the assert even if every other sample failed or no non-ordinary kinds were verified. Contradicts the "verified download receipts" requirement.

**Public script (merv-final-public-vm.py)**

4. **Asset-path inconsistency will break (or falsely pass) the public asset check.** Stage requests assets via `urllib.parse.urljoin('/ui/', path)` (handles relative paths like `assets/app.js`). Public requests `'https://…' + asset['path']` raw. If the manifest paths are relative, the public URL is malformed/missing the `/ui/` prefix → guaranteed check failure and rollback to maintenance; if the code paths differ, they're not verifying the same resources. These two must use identical URL construction.

5. **Caddyfile rewrite isn't scoped to the experiments site block.** `original.replace(b'reverse_proxy 127.0.0.1:8787', …)` replaces the single occurrence *anywhere* in the file. The only structural guard is that the tail after `sandboxes.rapidreview.io` is unchanged — nothing verifies the 8787 proxy actually sits inside the `experiments.rapidreview.io` block (or that the block even exists). If the edit lands in another site defined before the sandbox block, you publish the new backend under the wrong host. Add an assert that the replacement occurs within the experiments block.

## Real but non-blocking risks

- **Rollback fragility (public):** if `caddy reload` fails during the exception-path `install(maintenance)`, `run()` asserts and the site is left on the broken candidate config with no retry.
- **Membership diff against rehearsal schema** (`merv_ts_rehearsal_20260916v2`): the fresh snapshot may legitimately differ from the rehearsal import; a benign delta (e.g., membership added after rehearsal snapshot, before legacy stop) hard-fails the cutover. Fail-safe, but expect it.
- **Ready detection reads only `docker logs` stdout**; JSON status lines emitted to stderr would cause a false 60s timeout and rollback.
- **Non-idempotent stage script:** after one run, `typescript.env` no longer matches the backup copy (`assert old==backup copy`), so re-runs fail; also missing containers make the pre-try `docker inspect` calls raise `CalledProcessError` with no cleanup (safe here since nothing changed yet).
- Hardcoded counts (30/43/200) and hardcoded schema name duplicated in the SQL string vs. the `schema` variable — a future edit to one without the other silently queries the wrong schema. An f-string/param would be safer.
- `redir / /ui/ 302` matches only the exact root path; legacy deep links will 404 through the new backend — acceptable under "no perfect parity," just noting.

## Fine as-is

- Maintenance-page presence asserted before mutation; original Caddyfile hash-verified against cutover manifest; candidate validated before reload; sandbox tail-equality check; no-redirect handler correctly captures the 302 via `HTTPError`; env writer quotes values and rejects `'`/newlines; loopback-only port binding re-asserted; public acceptance correctly records `realAccountHttpsBrowserVerification: 'pending user'` (no invented approvals). I have not executed anything — this is source review only.

Fix items 1, 4, and 5 before running; 2 and 3 weaken the stated data-integrity gates and should be tightened in the same pass.
