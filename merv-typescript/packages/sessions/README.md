# Sessions

Continuing agent identity, authenticated sessions, and assignment execution lifecycle. The provider injects
`state`, `scope`, `workflows`, `domainEvents`; its optional `/api`
adapter injects `sessions` and `api`. Its optional `/ui` adapter injects `sessions` and `ui`. It creates no agent tools and launches no processes.

See [continuing agents and explicit assignment changes](../../docs/AGENT_CONTINUITY.md) for registration, self-control routes, identity semantics and migration.

Workflows owns the fixed policy and generic ownership hooks. Sessions freezes the
assignment, stores only the secret digest, validates source authority, activates
on first accepted MCP use, and closes expired or released workers. Domain plugins
release their exact old handles through durable events. Safe restarts retain the
lease; previously prepared invocations cannot survive a registration replacement.

See [HTTP routes, identity semantics and recovery](../../docs/SESSION_LEASES.md).
Run `npm run test:sessions` from the workspace root. `test:live:sessions` is the
separate real-agent acceptance harness, not a production runner.

[Automatic assignment and project controls](../../docs/RUNNER_CONTROL_PLANE.md) include default-off dispatch, pause/halt, source-bound runner presence, desired platform settings and transactional capacity checks. Workflows supplies metadata-only candidates; Sessions owns durable lease selection and retry receipts. `npm run test:live:dispatch -- /private/tmp/UNIQUE_DIRECTORY` exercises automatic HTTP assignment with two fresh agents.
