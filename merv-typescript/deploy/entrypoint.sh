#!/bin/sh
set -eu
umask 077
node /app/deploy/render-config.mjs /tmp/merv-config.json
exec node /app/dist/src/cli.js serve --dir /var/lib/merv-ts --config /tmp/merv-config.json --host 0.0.0.0 --port 3081
