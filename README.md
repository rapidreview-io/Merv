# Merv

Merv is a research platform for agents and humans, with durable research state,
reviewed experiments and tasks, managed Git, and a browser UI.

The current implementation lives in [merv-typescript/](merv-typescript/README.md).
It includes the backend, browser UI, runner, tests, and deployment tooling.

## Development

Requires Node.js 22.13 or later, npm, and PostgreSQL 17.

```sh
cd merv-typescript
npm ci
npm run typecheck
npm run typecheck:ui
npm run build
```

See the [implementation README](merv-typescript/README.md) for database setup,
server startup, and tests; see [deployment](merv-typescript/deploy/README.md)
for self-hosting and release instructions.

## Repository layout

- `merv-typescript/`: current application and supporting tools and documentation.
- `website/`: current React and TypeScript marketing site ([development instructions](website/README.md)).
- `Scenarios/`: research scenarios used by the TypeScript acceptance runner.
- `.github/workflows/merv-typescript-ci.yml`: TypeScript verification pipeline.

The former Python backend, JavaScript UI, client adapters, plugin marketplace
manifests, publishing workflow, and associated legacy materials have been moved
out of this repository into the sibling `../merv-legacy/` folder. Its
`ARCHIVE_MANIFEST.json` records the original paths and file checksums. This local
archive is not included when cloning the repository; historical committed files
remain available in Git history.
