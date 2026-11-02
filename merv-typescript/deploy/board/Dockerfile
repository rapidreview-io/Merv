# The board app, built from merv-typescript with its submodule. It runs from source under tsx.
FROM node:22-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
WORKDIR /app
COPY . .
RUN apt-get update && apt-get install --no-install-recommends -y git ca-certificates \
    && npm ci \
    && (cd packages/ui && npx vite build --config vite.board.config.ts) \
    && node scripts/build-board-renderer.mjs \
    && node node_modules/playwright-core/cli.js install --with-deps chromium-headless-shell \
    && rm -rf /var/lib/apt/lists/*
EXPOSE 3090
CMD ["node", "--import", "tsx", "scripts/board-server.ts"]
