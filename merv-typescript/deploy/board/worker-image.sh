#!/bin/sh
# Builds the Pi worker image on the board server from a source tree, as deploy/hosted-release-vm.py
# does for production: the Sandboxes base with its agent, the bundle with its tests, then
# scripts/hosted-runner/Dockerfile. Usage, from that tree: sh deploy/board/worker-image.sh TAG COMMIT
set -eu
TAG="$1" COMMIT="$2"
GO=golang:1.27.0-bookworm@sha256:ded31c68586d2e49e760acc2e65a884b23d032e9bbbed0ae0c55abd3fcaf4452
NODE=node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
SANDBOXES=vendor/merv-sandboxes
WORK=$(mktemp -d)
BIN=$SANDBOXES/deploy/cloudflare-sandbox/bin
printf 'FROM %s AS agent\nWORKDIR /src\nCOPY agent/ .\nRUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=%s" -o /out/sandboxes-agent-linux-amd64 ./cmd/sandboxes-agent\nFROM scratch\nCOPY --from=agent /out/ /\n' \
  "$GO" "$COMMIT" >"$WORK/agent.Dockerfile"
sudo docker build --platform linux/amd64 -f "$WORK/agent.Dockerfile" --output "type=local,dest=$BIN" "$SANDBOXES"
sudo docker build --platform linux/amd64 -f "$SANDBOXES/deploy/cloudflare-sandbox/Dockerfile" -t "$TAG-base" "$SANDBOXES"
printf 'FROM %s AS build\nWORKDIR /app\nCOPY . .\nRUN npm ci --no-audit --no-fund && node scripts/hosted-runner/build.mjs /bundle && node --import tsx --test tests/pi-worker.test.ts tests/pi-worker-relay-protocol.test.ts tests/pi-relay.test.ts\nFROM scratch\nCOPY --from=build /bundle/ /\n' \
  "$NODE" >"$WORK/bundle.Dockerfile"
sudo docker build --platform linux/amd64 -f "$WORK/bundle.Dockerfile" --output "type=local,dest=$WORK/bundle" .
sudo docker build --platform linux/amd64 -f scripts/hosted-runner/Dockerfile --build-arg "SANDBOX_IMAGE=$TAG-base" \
  --label "org.merv.board.source-commit=$COMMIT" -t "$TAG" "$WORK/bundle"
sudo rm -rf "$WORK"
