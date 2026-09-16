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
COPY deploy/render-config.mjs deploy/schema.mjs deploy/legacy-rehearsal.mjs deploy/entrypoint.sh ./deploy/
# npm's workspace symlinks resolve to /app/packages; the deployed packages are compiled JS.
RUN ln -s dist/packages packages
USER node
EXPOSE 3081
ENTRYPOINT ["/bin/sh", "/app/deploy/entrypoint.sh"]
