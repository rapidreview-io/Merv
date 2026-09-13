# Execution evidence

The acceptance criteria and ordering are in [EXECUTION_PLAN.md](EXECUTION_PLAN.md). A step is complete only when its gate is verified. The existing Python application is separate from this implementation.

## Current position

- Step 1: complete; clean-checkout installation, tests, CLI, authentication, restart, and cleanup verified.
- Step 2: next — repair the two reproduced lifecycle failures.
- Steps 3–15: not started.
- Subsequent experiment, reflection, hosted access, and migration work: not started.

## Step 1 — reproducible baseline

Branch: `codex/cordis-stack`.

- `5941a55d`: captured the existing Cordis prototype, tests, lockfile, and execution plan as a subtree.
- `3bc7d446`: separately applied formatting, pinned Prettier, declared the development runtime, and protected credential files in custom data directories.
- Existing baseline typecheck and build pass. All **56 checks** pass with loopback permission; the first restricted run could not bind HTTP listeners, and the unrestricted repeat verified all tests rather than skipping them.
- Independent manifest audit found consistent workspace and lockfile entries, relative workspace links, registry tarball integrity metadata, and no private runtime files in the tracked baseline.
- Runtime verified locally: Node 22.13.1, npm 11.1.0, Cordis 4.0.0-rc.10, MCP SDK 1.30.0, TypeScript 5.9.3, tsx 4.23.13, Zod 3.25.76, Prettier 3.9.6.

Independent clean-checkout verification passed at exact commit `3bc7d446b0df36b286542782553f581fe43b5ef3`. A fresh sparse checkout installed 115 packages from the committed lockfile and passed formatting, typecheck, build, and all 56 tests. Documented CLI commands initialized a project and producer/reviewer/reader credentials. Both server starts exposed 26 tools; all four identities authenticated, unauthenticated access was refused, and foreign project scope was denied. A synthetic artifact and its project survived the restart. Both server processes and listeners were confirmed stopped; the checkout remained clean. The second shutdown used SIGTERM and exited successfully.

[Machine-readable baseline report](verification/step-01-baseline.json) records exact commands, statuses, and cleanup evidence without credentials.
