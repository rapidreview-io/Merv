#!/bin/zsh
# The runner's own claude launch, with two changes and nothing else: the session is
# persisted (so the worker can be interviewed after it finishes) and its stdin and
# stream are saved beside the run. Arguments are passed through exactly as built.
set -u
OUT=/private/tmp/claude-501/-Users-guraltoo-Documents-dev-proj-experiments-Merv/432a7267-efe6-4501-a97b-38a340f80fdd/scratchpad/fleet/launches
export CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude-cli-second}
mkdir -p $OUT
id=$(/usr/bin/uuidgen | tr 'A-Z' 'a-z')
stamp=$(date -u +%Y%m%dT%H%M%SZ)
args=()
for a in "$@"; do
  [[ "$a" == "--no-session-persistence" ]] && continue
  args+=("$a")
done
cat > $OUT/$stamp-$id.stdin
< $OUT/$stamp-$id.stdin claude "${args[@]}" --session-id "$id" > $OUT/$stamp-$id.jsonl 2> $OUT/$stamp-$id.err
code=$?
echo "{\"launch\":\"$stamp-$id\",\"exit\":$code}" >> $OUT/index.jsonl
exit $code
