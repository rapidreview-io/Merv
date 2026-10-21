# Code operations

Code serves one native Git remote per project. Tasks and experiments use ordinary Git inside their assigned workspaces. Review and integration remain Merv workflow operations: pushing a branch does not approve it or move the managed main branch.

## Remote and authentication

The Git page shows the project’s actual URL and a copyable clone command:

```sh
git clone https://merv.example/git/PROJECT_ID.git
```

Use a nonempty username such as `merv`, and an existing Merv user key as the password. Keep the key in a credential manager rather than in the URL or shell history. Project administrators can push ordinary user branches. `merv`, `merv/*`, `merv-main`, `merv-main/*` and internal refs are reserved for Merv. Deletion and non-fast-forward pushes are refused.

An existing namespace collision returns `409 code_ref_collision` with the blocking ref and object ID before aliases change. Requests and restarts never rename or delete that history. A repository administrator must choose an explicit mapping. With the repository owner stopped and a consistent backup available, the example below moves a colliding user branch `merv` to the unused name `user-merv-history` in the server's bare repository. Verify that the first command reports the error's object ID and the last reports the same ID, then restart the owner and retry clone/fetch. Use the actual repository path and deliberately chosen branch names; `branch -m` refuses to overwrite an existing destination.

```sh
git --git-dir=/absolute/path/repository.git show-ref --verify refs/heads/merv
git --git-dir=/absolute/path/repository.git branch -m merv user-merv-history
git --git-dir=/absolute/path/repository.git show-ref --verify refs/heads/user-merv-history
```

A hosted worker receives a short-lived Git grant restricted to its project, work unit, session, writer generation and branch. The remote checks the grant on every request and checks the current writer fence before accepting a push. Review workspaces receive read access only. Source revocation, a closed session or a newer generation removes ordinary write authority.

The transport uses native `git http-backend`, including Git's protocol negotiation and gzip handling. Successful ordinary pushes are immediately visible in the remote. Native Git owns the ref transaction; Merv validates admission and reconciles its outcome into workspace metadata before replying. After a server restart, a retained FIFO proves the previous receiver has exited. An unresolved outcome fences the writer until reconciliation; a refused push is never replayed as another ref update.

Upload/download bundle routes, `merv code-import`, the `code.commit` and `code.merge` wrappers, and command polling routes are removed. GitHub credentials, connections, imports, mirrors and PR automation are removed; historical review and publication evidence remains readable. See [the retirement migration](GITHUB_REPOSITORIES.md).

## Work, review and planned shutdown

A writer starts on its pinned work branch. Its Git commands can create commits and push them normally. Session closure retains the agent’s commits and leaves its uncommitted working tree available for the next phase on the same work host. Closure does not make a periodic or final WIP commit.

Submitting a task delivery or experiment result requests an immutable submission. Once the producer has stopped, the runner freezes the parent commit and exact working tree, including tracked changes and nonignored new files, and pushes their retained refs. The reviewer receives that parent plus that exact tree. Later producer changes cannot change what was submitted. Approval materializes at most one commit when the reviewed tree differs from the parent and records the exact accepted reference. Dependencies remain blocked until that reference is durable.

Before planned VM teardown, Fleet records a shutdown request. The supervisor stops every producer, settles sessions and requested submissions, then captures any remaining writer files. It creates a commit only when the retained tree needs one, pushes it through native Git, verifies the result and returns a receipt naming each session, unit, head, tree and durable operation. Sessions verifies those exact facts before acknowledging the receipt; only then may Fleet delete the host. A lost response or unavailable remote keeps the capture pending and retries the same journaled result. Unexpected provider loss can still lose files that were never pushed.

Shutdown cleanup authority is narrow: the existing managed control credential must match the allocation and epoch, and only owned historical session cleanup and final Git capture are allowed. It cannot obtain new leases, run model requests or use ordinary write grants. Acknowledgement revokes the derived shutdown grant.

## Integrating outside history

Push an ordinary user branch to the project remote first. Then use `code.write` with `repository_prepare`, naming the branch, exact head, expected managed-main head and a stable request ID. Preparation checks that retained branch and creates independently reviewed integration work. It does not rewrite existing work’s pinned bases or directly advance main.

Accepted work and reviewed integration use the local publication journal. Main moves by compare-and-swap to a verified reviewed result; main movement can require a successor integration task. `code.read` with `status` shows repository state, units, bases and publication records. The Git page shows local integration and historical external publication evidence.

## Units and automatic bases

A task or experiment has one immutable base pin and one immutable acceptance. The first producing lease derives its base from declared dependencies’ accepted references and pins that result. Later leases use that same pin. Several accepted dependencies share a deduplicated merge plan; a conflict creates one reviewed resolution task for the waiting units. A system prerequisite resolves the conflict without becoming an additional code source.

A read never pins or advances a unit. Missing acceptances, unavailable retained objects, unresolved submissions and dependency changes block work at lease admission. `code.read` with `unit` reports a unit’s pin, acceptance and blockers; `status` reports project blockers and shared bases. Historical workflow definitions remain unchanged. Eligible idle work can cross an explicit, audited revision boundary using the [offline migration](../deploy/NATIVE_GIT_CUTOVER_PLAN.md); other legacy work must drain first.

Administrators can use `code.write` actions `base_retry`, `base_suspend`, `base_resume`, `base_cancel`, `base_quarantine`, `base_release`, `base_repair` and `unit_fence` with their required reason and request ID. These controls retain their audit records. Quarantine blocks affected results and descendants; it does not rewrite a sealed result. Repair is refused for running, quarantined or sealed base results.

Project checks remain available through `repository_configure`. Every call states `check`: either `null`, or a command, timeout and sandbox image specification. Checks run on the configured sandbox adapter, never in a server shell. Budget, capacity and provider waits remain visible through Sessions and Code blockers.

## Storage and admission

Code owns the project’s bare repository under the configured Code root and serializes repository mutations. One server process owns a volume at a time. Back up PostgreSQL and the Code repositories consistently: database references require their matching retained Git objects.

The native receive path validates object connectivity, supported format, lineage, object and file limits, tree modes, names, symlinks, submodules, deny globs and recognizable credential patterns before publishing refs. Findings report rule, path and object identity without echoing matched secrets. `secretExemptGlobs` addresses deliberate fixtures; every new placement of retained content is checked against its current path and policy.

The old internal admission journal remains for historical records and drain recovery. Its import, upload, multipart and completion constructors are removed; recovery can only finish operations already persisted by the previous runtime. GitHub retirement settles queued external work with explicit reasons, preserves admitted recovery obligations, and creates separate local successors for eligible reviewed publications instead of rewriting their original external evidence.

## API and validation

`/git/<project-id>.git` carries Git smart HTTP. The runner’s bounded JSON metadata calls under `/code/v2/` describe workspaces, issue Git grants, acknowledge pushed objects, freeze submissions and close sessions. `/sessions/runners/shutdown` is the authenticated planned-teardown request/status/receipt channel. The retired bundle and command routes return 404.

Code Work owns research policy, immutable submission and acceptance records; Code owns storage, admission and Git HTTP; Sessions owns runner and cleanup authorization; Fleet owns host lifetime; Runner owns local processes and capture journals. Each owner validates the part of the receipt it can prove.

Tests exercise real local Git HTTP, rejected pushes and stale grants, immutable submission replay, independent review, migration, lost acknowledgements and shutdown release gating. Test presence alone does not establish a production rollout: the read-only cutover preflight must pass, and Linux isolation gates must run against the proposed hosted image. See [hosted runner operations](../scripts/hosted-runner/README.md).
