# Code as an optional utility

Status: implementation in progress, 2026-09-22.

Code supplies durable Git operations for parallel research. It never decides research
logic. Research owners choose dependencies, accepted results, review requirements,
resolution work and publication obligations. An optional research integration translates
those decisions into Code operations.

## Required boundaries

- Code has no Workflows or Reviews dependency, including private table reads, workflow
  names/versions, research event subscriptions or policy hidden behind proxy interfaces.
- Code retains repository integrity, exact revisions, writer fencing, transport and
  technical operation receipts. Its research integration owns workflow blockers,
  dependency traversal, review provenance and integration/publication decisions.
- A full research cycle can finish with Code absent. Explicit Git obligations remain
  durable and block safely while Code is unavailable; absence never means approval.
- GitHub remains optional for Git work. Scratch execution requires no Git repository.
- Review acceptance and its exact code evidence remain transactionally consistent.
- Existing retained records and frozen workflow versions remain supported.

## Product behavior

A researcher connects a repository, selects any valid branch as the project base, and prepares
its history with one action. GitHub's default branch is only a suggestion. Preparation freezes
the selected branch and commit across retries, refuses a changed repository connection, and
reports ready only when the exact commit is stored. Existing pinned work keeps its original
base. The UI shows the selected branch, import progress and recovery, and linked changes.

## Configuration migration

- Keep `code` at `@merv/code` with repository root/quota/free-space settings.
- Move writer grace to core `finalizeGraceSeconds` (default 900 seconds).
- Add `code-research` at `@merv/code-research`. Its `repositories` settings own sweep/drain,
  automatic bases, mirror cadence and backup configuration.
- Point `code-tools`, `code-api` and `code-ui` to `@merv/code-research/{tools,api,ui}`.
- Research consumers bind optional `codeResearch`; standalone utilities bind `code`.
- Use `config/no-code.example.json` and runner `workspaceDrivers: []` for no-Git execution.

The actual staging configuration used only core `repositories.root`, so it has no operational
settings to relocate. The deployment renderer explicitly requires the integration in the full
Git-enabled staging profile; the ordinary default keeps it optional.

## Implementation sequence

1. Separate policy from durable Code data and Git operations; make optional integration
   an explicit composition entry rather than a dependency of the utility.
2. Fix research completion without Git and remove obsolete stage dependencies.
3. Narrow workspace command contracts and load machine drivers only where needed.
4. Simplify duplicate/dead integration paths, remove cross-owner database reads, update
   configuration and documentation. Measure total source reduction, including moved code.
5. Run relevant tests, full source/build checks and staging acceptance, including a full
   no-Code cycle and safe suspension/resumption of Git work.

## Staging

The verified staging host is `azureuser@dev-experiments.rapidreview.io` (`rp-control-dev`),
public origin `https://dev-experiments.rapidreview.io`, database schema `merv_ts_staging`.
The release script defaults to production: both staging arguments must be explicit.
It ships committed HEAD and does not back up the database. Any schema migration requires
a separate staging backup before deployment. Historical September 16 staging instructions
describe the host subsequently promoted to production.

## Completion evidence

Server/UI typechecks and builds passed. Targeted gates cover command input validation,
GitHub permissions and pagination, exact repository preparation/replay, no-Code research,
core mutation projections, generic-owner isolation, writer recovery, and hosted adapter
unload while core repositories remain usable. Full local and PostgreSQL staging gates are
still being completed.

The current measured physical source count (2026-09-22, baseline `32a0920f`) is 19,234 →
19,618 across Code plus its new adapter; all package `src/**/*.ts` files are 67,251 → 67,729.
Moves are counted on both sides. **The net source-reduction requirement is not yet achieved.**
New optionality, lifecycle and repository setup behavior outweigh the removed duplication.
Further simplification must retain validation and recovery; moving code or deleting useful
comments is not a reduction in responsibility.

Pending: dependency audit, total source count/diff, full no-Git lifecycle, Git handoff and
review regressions, builds, staging image/release identity, authenticated acceptance and
restart persistence. Moving files alone is not simplification or proof of completion.
