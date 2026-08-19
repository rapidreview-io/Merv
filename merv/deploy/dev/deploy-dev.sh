#!/usr/bin/env bash
# Deploy one commit of this repository to the Merv dev brain VM.
#
#   deploy/dev/deploy-dev.sh [--skip-ui] [<commit-ish>]     (default: HEAD)
#
# Runs from a laptop checkout: it ships `git archive <sha>` to
# ~/releases/merv-<sha8>/ on the VM (no Git credentials live on the VM),
# builds research_state_ui locally and rsyncs dist/ to /srv/merv-ui, renders
# the Caddyfile, takes a pg_dump, brings the compose stack up from the release
# directory, health-gates the brain, and probes the public host.
#
# One-time VM setup (Docker, Caddy, the three env files) is in README.md.
set -euo pipefail

SSH_TARGET="${MERV_DEV_SSH:-azureuser@rp-control-dev.eastus2.cloudapp.azure.com}"
VM_DIR='$HOME/research-suite-vm'
SKIP_UI=0
COMMITISH=HEAD
for arg in "$@"; do
  case "$arg" in
    --skip-ui) SKIP_UI=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) COMMITISH="$arg" ;;
  esac
done

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
SHA="$(git rev-parse --verify "${COMMITISH}^{commit}")"
SHA8="${SHA:0:8}"
REL="\$HOME/releases/merv-${SHA8}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new"
remote() { ssh $SSH_OPTS "$SSH_TARGET" "$@"; }

say "target $SSH_TARGET, commit $SHA"
HOST="$(remote "grep -E '^MERV_DEV_HOST=' $VM_DIR/dev.env | cut -d= -f2-")"
[ -n "$HOST" ] || { echo "MERV_DEV_HOST missing in $VM_DIR/dev.env on the VM (see README.md)"; exit 1; }
echo "public host: $HOST"

say "ship source"
if remote "[ -f $REL/merv/pyproject.toml ]"; then
  echo "release already present at $REL"
else
  git archive --format=tar "$SHA" \
    | remote "set -e; rm -rf $REL.tmp; mkdir -p $REL.tmp; tar -x -C $REL.tmp; mv $REL.tmp $REL"
  echo "unpacked into $REL"
fi

if [ "$SKIP_UI" = 0 ]; then
  say "build and sync UI"
  if [ "$(git rev-parse HEAD)" != "$SHA" ] || [ -n "$(git status --porcelain -- research_state_ui)" ]; then
    echo "note: the UI is built from the working tree, which differs from $SHA8"
  fi
  # Same-origin build: the UI calls the brain that serves it. The explicit
  # empty values beat any laptop .env.local (which may point at prod and may
  # carry a personal token — neither belongs in a public bundle).
  (cd research_state_ui && VITE_API_BASE= VITE_API_TOKEN= npm run build --silent)
  if grep -rlE '(rpt_|rr_sk_|mk_)[A-Za-z0-9_-]{16,}' research_state_ui/dist/assets >/dev/null 2>&1; then
    echo "refusing to ship: a token-shaped string is baked into research_state_ui/dist"; exit 1
  fi
  printf '%s\n' "$SHA" > research_state_ui/dist/release.txt
  rsync -a --delete -e "ssh $SSH_OPTS" research_state_ui/dist/ "$SSH_TARGET:/srv/merv-ui/"
  echo "synced research_state_ui/dist → /srv/merv-ui"
fi

say "caddy"
remote "set -e
  sed \"s/__MERV_HOST__/$HOST/g\" $REL/merv/deploy/dev/Caddyfile.template > /tmp/Caddyfile.rendered
  if ! sudo cmp -s /tmp/Caddyfile.rendered /etc/caddy/Caddyfile; then
    sudo caddy validate --config /tmp/Caddyfile.rendered --adapter caddyfile >/dev/null
    sudo install -m 0644 /tmp/Caddyfile.rendered /etc/caddy/Caddyfile
    sudo systemctl enable --now caddy >/dev/null 2>&1
    sudo systemctl reload caddy
    echo 'Caddyfile updated and reloaded'
  else
    echo 'Caddyfile unchanged'
  fi"

say "backup"
remote "set -e
  if sudo docker ps --format '{{.Names}}' | grep -qx deploy-supabase-db-1; then
    out=$VM_DIR/pre-deploy-${SHA8}-\$(date -u +%Y%m%d-%H%M%S).dump
    sudo docker exec deploy-supabase-db-1 pg_dump -U postgres -d postgres -Fc > \"\$out\"
    echo \"pg_dump → \$out (\$(du -h \"\$out\" | cut -f1))\"
  else
    echo 'no database container yet; nothing to back up'
  fi"

say "compose up"
remote "set -e; cd $REL/merv
  sudo docker compose \
    --env-file $VM_DIR/provider-secrets.env \
    --env-file $VM_DIR/supabase-db.env \
    --env-file $VM_DIR/dev.env \
    -f deploy/docker-compose.yml \
    -f deploy/docker-compose.supabase.yml \
    -f deploy/dev/docker-compose.dev.yml \
    up --build -d --remove-orphans 2>&1 | tail -n 25"

say "health"
remote "set -e
  for _ in \$(seq 1 150); do
    status=\$(sudo docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}unknown{{end}}' deploy-control-1 2>/dev/null || echo missing)
    if [ \"\$status\" = healthy ]; then
      curl -fsS http://127.0.0.1:8787/api/meta | head -c 300; echo
      echo \"control healthy, release \$(sudo docker inspect deploy-control-1 --format '{{index .Config.Labels \"com.docker.compose.project.working_dir\"}}')\"
      exit 0
    fi
    sleep 2
  done
  echo 'control did not become healthy'; sudo docker logs --tail 60 deploy-control-1 >&2; exit 1"

say "public probes"
curl -fsS -o /dev/null -w "GET https://$HOST/api/meta → %{http_code}\n" "https://$HOST/api/meta"
curl -fsS -o /dev/null -w "GET https://$HOST/merv/ → %{http_code} %{content_type}\n" "https://$HOST/merv/"
served="$(curl -fsS "https://$HOST/merv/release.txt" 2>/dev/null || true)"
echo "UI release.txt: ${served:-<missing>} (brain: $SHA)"
echo
echo "done: https://$HOST/merv/  (MCP: https://$HOST/mcp)"
