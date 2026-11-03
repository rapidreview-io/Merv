#!/bin/sh
# Sends this checkout to the board server and brings it up: deploy/board/deploy.sh [ssh target]
set -eu
TARGET="${1:-azureuser@merv-board.eastus2.cloudapp.azure.com}"
cd "$(dirname "$0")/../.."
tar czf - --exclude node_modules --exclude dist --exclude dist-board --exclude .git --exclude '*.log' . |
  ssh "$TARGET" 'rm -rf ~/board.new && mkdir ~/board.new && tar xzf - -C ~/board.new && rm -rf ~/board && mv ~/board.new ~/board'
ssh "$TARGET" 'cd ~/board/deploy/board && sudo docker compose --env-file /etc/merv-board/compose.env up -d --build'
