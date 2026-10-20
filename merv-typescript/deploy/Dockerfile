# Build from the merv-typescript directory. Pin NODE_IMAGE to a reviewed digest for a release.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build:ui && npm run build \
    && node deploy/prepare-runtime.mjs && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ARG SANDBOXES_TS_IMAGE
LABEL org.merv.sandboxes-image=${SANDBOXES_TS_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/vendor/merv-sandboxes/typescript/packages ./vendor/merv-sandboxes/typescript/packages
COPY --from=build /app/vendor/merv-sandboxes/typescript/hosts/merv ./vendor/merv-sandboxes/typescript/hosts/merv
COPY deploy/render-config.mjs deploy/schema.mjs deploy/entrypoint.sh ./deploy/
# Code keeps one Git repository per project on the data volume and is the only part of the
# server that runs Git. It looks for it at /usr/bin/git, needs 2.38 or newer, and refuses to
# start with code_git_unsupported without it.
RUN apt-get update \
    && apt-get install --no-install-recommends -y git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && /usr/bin/git --version
# Reports renders experiment reports to PDF in a headless Chromium: the build Playwright pins,
# with its system libraries. Fonts are embedded by Reports; the page has no network.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN node node_modules/playwright-core/cli.js install --with-deps chromium-headless-shell \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /opt/ms-playwright
# npm's workspace symlinks resolve to /app/packages; the deployed packages are compiled JS.
RUN ln -s dist/packages packages
RUN groupadd --gid 10001 merv && useradd --uid 10001 --gid 10001 --create-home merv
RUN node --import tsx --input-type=module -e "await import('@sandboxes/merv-host'); const m = await import('@sandboxes/ssh'); if (!m.patchApplied()) process.exit(1)"
USER 10001:10001
# script.run's sandbox runs under Node's permission model from these files; a Node or a layout it
# cannot start in fails the build here, not every script with script_unavailable.
RUN node --import tsx --input-type=module -e "const { runScript } = await import('@merv/scripts/bridge'); const r = await runScript('return 1', 5000, [], async () => null); if (r.result !== 1) process.exit(1)"
EXPOSE 3081
ENTRYPOINT ["/bin/sh", "/app/deploy/entrypoint.sh"]
