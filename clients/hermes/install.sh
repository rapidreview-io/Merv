#!/bin/sh
set -eu

client_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
plugin_dir=$(CDPATH= cd -- "$client_dir/../.." && pwd)
hermes_dir=${HERMES_HOME:-"$HOME/.hermes"}
skills_dir="$hermes_dir/skills"

mkdir -p "$skills_dir"

# Refuse to merge into or replace a real user-owned skill directory. Preflight
# every target before making changes so a conflict cannot leave a partial
# install.
for skill_dir in "$plugin_dir"/skills/*; do
    [ -f "$skill_dir/SKILL.md" ] || continue
    skill_name=${skill_dir##*/}
    skill_target="$skills_dir/$skill_name"
    if [ -e "$skill_target" ] && [ ! -L "$skill_target" ]; then
        printf '%s\n' \
            "Refusing to replace existing Hermes skill directory: $skill_target" >&2
        exit 1
    fi
done

for skill_dir in "$plugin_dir"/skills/*; do
    [ -f "$skill_dir/SKILL.md" ] || continue
    skill_name=${skill_dir##*/}
    ln -sfn "$skill_dir" "$skills_dir/$skill_name"
done

cat <<'EOF'
Installed Merv skills for Hermes Agent.

Add one of these entries under mcp_servers in ~/.hermes/config.yaml (or
$HERMES_HOME/config.yaml).

Bearer key:

  merv:
    url: "https://experiments.rapidreview.io/mcp"
    headers:
      Authorization: "Bearer ${MERV_MCP_KEY}"

OAuth:

  merv:
    url: "https://experiments.rapidreview.io/mcp"
    auth: oauth

For OAuth, finish with:

  hermes mcp login merv
EOF
