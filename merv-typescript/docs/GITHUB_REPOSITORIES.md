# Retired GitHub integration

Merv no longer connects GitHub accounts or calls GitHub APIs. The user's own agent manages
GitHub with ordinary Git and its existing credentials. Merv supplies a project Git remote;
no Merv CLI, watcher, daemon, or credential helper is needed on the user's machine.

The upgrade removes Merv's OAuth connection and pending sign-in tables, including stored
access/refresh credentials. The GitHub App environment settings and private-key reader,
connection routes, repository picker, import automation, mirror worker, pull-request
publication and merge controls are removed. Deployment operators can delete the unused
GitHub App secrets from their external secret manager after the new server is deployed.
The code upgrade cannot remove secrets from an external deployment system.

No migration closes a pull request, deletes a repository, changes a GitHub branch, or calls
an external API. Existing commits, repository identities, review certificates, acceptance
records, publication records, PR links and recorded merge intents remain intact.

Pending mirror jobs and GitHub imports that never finished receiving are retired with the
explicit reason `github_integration_retired`. Imports already admitted continue only from
the bytes retained locally. Unsettled external publications are retired in place; an
independently approved pending publication receives one separate local successor record.
The unit retains its original immutable publication pointer and follows that successor for
local integration. Replaying the migration creates no duplicate successor.

A user branch push and advancement of the research baseline are separate. After pushing
history, a project administrator selects the retained source branch and exact commit with
`code.write:repository_prepare`, supplying `baseBranch`, `headOid`, `expectedMainOid` and a
stable `requestId`. New history requires an independent integration task; the final retry
advances the baseline with compare-and-swap. Running experiments keep their existing pins.

See [Code operations](CODE_OPERATIONS.md) for the current transport and lifecycle policy.

## Using the project remote

The Code page shows the exact remote URL, `https://<merv-host>/git/<projectId>.git`.
Run `git clone <remote-url>`. When Git asks, use `merv` as the username and your
existing Merv user key as the password; use a credential manager instead of placing
the key in the URL. A key reads projects its account can read. Pushing user branches
requires project administration. Push an imported source branch, then select its
exact head with repository preparation to start the independent integration review.
`merv-main` and `merv/*` belong to Merv and cannot be pushed by user keys.

Planned hosted-machine release has its own durable handshake. Fleet requests
shutdown, the supervisor stops producers and retains requested submissions, then
commits and pushes remaining writer state and verifies the retained objects. Only
a receipt checked against completed final Git operations permits provider deletion.
Transfer failure leaves the host pending and renewed for retry; ordinary session
release alone never acknowledges machine shutdown. An externally lost VM cannot
supply a final capture.
