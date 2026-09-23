# Build from the merv-typescript directory. Pin NODE_IMAGE to a reviewed digest for a release.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build:ui && npm run build \
    && node deploy/prepare-runtime.mjs && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY deploy/render-config.mjs deploy/schema.mjs deploy/entrypoint.sh ./deploy/
# Code keeps one Git repository per project on the data volume and is the only part of the
# server that runs Git. It looks for it at /usr/bin/git, needs 2.38 or newer, and refuses to
# start with code_git_unsupported without it.
RUN apt-get update \
    && apt-get install --no-install-recommends -y git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && /usr/bin/git --version
# npm's workspace symlinks resolve to /app/packages; the deployed packages are compiled JS.
RUN ln -s dist/packages packages
USER node
EXPOSE 3081
ENTRYPOINT ["/bin/sh", "/app/deploy/entrypoint.sh"]
