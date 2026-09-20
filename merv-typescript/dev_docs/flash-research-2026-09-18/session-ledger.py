"""Count actual CLI sessions across controller resumes and interactive reviews."""
from pathlib import Path
import collections, json

here = Path(__file__).resolve().parent
root = here / 'run'
files = (list((root/'launches').glob('*.jsonl'))
    + list((root/'interactive-reviews').glob('*.jsonl'))
    + list((root/'machine-18764/launches').glob('*/stdout.log')))
sessions = []
usage = collections.Counter()
for path in sorted(files):
    ids, turns, failures = [], [], []
    for line in path.read_text().splitlines():
        try: item = json.loads(line)
        except json.JSONDecodeError: continue
        if item.get('type') == 'thread.started': ids.append(item['thread_id'])
        if item.get('type') == 'turn.completed': turns.append(item.get('usage', {}))
        if item.get('type') == 'turn.failed': failures.append(item.get('error'))
    if not ids: continue
    for turn in turns: usage.update({k:v for k,v in turn.items() if isinstance(v,int)})
    sessions.append({'thread_ids':ids, 'transcript':str(path.relative_to(root)),
        'reported_turn_completions':len(turns), 'reported_usage':turns,
        'reported_turn_failures':failures})
result = {'source':'Distinct thread.started IDs in retained Codex CLI JSONL logs.',
    'configured_model':'deepseek-flash via codex-flash-research launcher',
    'distinct_cli_sessions':len({i for s in sessions for i in s['thread_ids']}),
    'usage_caveat':'Reported token sums are incomplete: interrupted sessions and workers stopped after workflow handoff often lack a turn.completed usage record. These are not a billing total.',
    'reported_usage_sum':dict(usage), 'sessions':sessions}
(here/'session-ledger.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'distinct_cli_sessions':result['distinct_cli_sessions'], 'logs':len(sessions)}))
