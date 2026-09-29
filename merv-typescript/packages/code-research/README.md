# Code research integration

This optional adapter connects research decisions to the [Code utility](../code/README.md).
Research owners decide dependencies, accepted outcomes, review requirements and publication
obligations. The adapter translates those decisions into exact code pins, isolated writers,
retained evidence, dependency blockers, conflict-resolution work and publication operations.
It never makes Code itself depend on a research service.

It provides `ctx.codeResearch`; Tasks, Experiments, Research, Consolidation and Knowledge
bind to that capability only when present. Reviews and Sandboxes are optional collaborators.
A review-dependent action remains unavailable while its provider is absent; a missing plugin
never grants acceptance or erases an existing Git obligation.

| Module                      | Dependencies        | Interface                                                    |
| --------------------------- | ------------------- | ------------------------------------------------------------ |
| `@merv/code-research/tools` | CodeResearch, Tools | `code.*` tools                                               |
| `@merv/code-research/ui`    | CodeResearch, UI    | Repository connection, selected base and retained operations |
| `@merv/code-research/api`   | CodeResearch, API   | The `/code/*` machine and GitHub routes                      |

The API adapter mounts `/code`, with GitHub's OAuth callback public. Unloading CodeResearch withdraws those routes, which then answer 503, without stopping the API.

The default composition enables the integration, with both Code and CodeResearch optional.
Disable Code to suspend all its adapters, or disable CodeResearch to retain a standalone Git
utility. Use [the no-Code configuration](../../config/no-code.example.json) to start research
without any Code entries. Existing Git work waits for restoration; code-free research can
complete its full review and reflection lifecycle.

GitHub's default branch and the branch selected for Merv are different settings. The selected
branch is the project's base, whatever its name. Each running unit keeps its exact starting
commit, so changing the project base cannot rewrite work already pinned to an older commit.
Connection, retained server history, accepted changes and remote publication remain visible
as distinct states. Connecting a repository is not approval to merge a research outcome.

The adapter retains the legacy command/proposal and workflow evidence needed for recovery.
Review provenance is read through the Reviews service rather than its private tables.
