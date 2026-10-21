#!/usr/bin/env python3
"""Real terminal-client acceptance. Standard library only; never calls Merv HTTP."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shlex
import shutil
import signal
import subprocess
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]

def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()

def read(path):
    return json.loads(Path(path).read_text())

def write(path, value):
    path = Path(path)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, indent=2) + '\n')
    tmp.chmod(0o600)
    tmp.replace(path)

SECRET_KEYS = frozenset(('access_token', 'refresh_token', 'id_token', 'api_key',
                         'authorization', 'client_secret', 'token', 'password'))
# scope/oauth.ts and identity/credentials.ts mint 32 random bytes as 43 base64url
# characters. Prefixless actor credentials require field/Bearer context: matching
# arbitrary opaque IDs would destroy workflow evidence.
MERV_TOKEN = re.compile(r'(?<![A-Za-z0-9_-])(?:mo_|mrfr_|mk_|mi_)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])')
ESCAPED_SECRET = re.compile(
    r'(?P<quote>\\*")(?P<key>' + '|'.join(sorted(SECRET_KEYS)) +
    r')(?P=quote)\s*:\s*(?P=quote).*?(?P=quote)', re.IGNORECASE)

def redact(text, _depth=0):
    # Decode transcript JSON and embedded JSON strings so escaped quotes (or
    # unicode escapes) cannot hide sensitive fields. Preserve valid JSON events.
    if _depth < 32:
        try:
            parsed = json.loads(text)
        except (ValueError, RecursionError):
            parsed = None
        if isinstance(parsed, (dict, list, str)):
            def scrub(value):
                if isinstance(value, dict):
                    return {key: '[REDACTED]' if key.lower() in SECRET_KEYS else scrub(child)
                            for key, child in value.items()}
                if isinstance(value, list):
                    return [scrub(child) for child in value]
                if isinstance(value, str):
                    return redact(value, _depth + 1)
                return value
            return json.dumps(scrub(parsed), ensure_ascii=True)
    return redact_plain(text)

def redact_plain(text):
    # Also cover non-JSON prose and malformed/truncated embedded JSON.
    text = MERV_TOKEN.sub('[REDACTED]', text)
    text = ESCAPED_SECRET.sub(lambda m: m['quote'] + m['key'] + m['quote'] +
                             ': ' + m['quote'] + '[REDACTED]' + m['quote'], text)
    # Defense in depth: clients must never be asked to display credentials.
    text = re.sub(r'(?i)(Bearer\s+)[^\s"\\]+', r'\1[REDACTED]', text)
    text = re.sub(r'(?i)("(?:access_token|refresh_token|id_token|api_key|authorization|client_secret)"\s*:\s*")[^"]*', r'\1[REDACTED]', text)
    text = re.sub(r'(https?://)[^/\s@]+@', r'\1[REDACTED]@', text)
    text = re.sub(r'https?://[^\s"<>\\]+', lambda m: m[0].split('?')[0].split('#')[0] + ('?[REDACTED]' if '?' in m[0] or '#' in m[0] else ''), text)
    text = re.sub(r'\b(?:sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b', '[REDACTED]', text)
    return text

def capture(argv, env, cwd, destination, timeout=600, cap=8_000_000):
    """Bound memory/disk and kill the entire process group on any exit path."""
    p = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(p.stdout, selectors.EVENT_READ)
    start, total, pending, reason = time.monotonic(), 0, b'', None
    try:
        with Path(destination).open('w') as out:
            while selector.get_map():
                if time.monotonic() - start > timeout:
                    reason = 'timeout'; break
                for key, _ in selector.select(.2):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj); continue
                    total += len(chunk)
                    if total > cap:
                        reason = 'output_limit'; break
                    pending += chunk
                    # Never persist a partial token across redaction boundaries.
                    if len(pending) > 1_000_000 and b'\n' not in pending:
                        reason = 'oversize_line'; break
                    while b'\n' in pending:
                        line, pending = pending.split(b'\n', 1)
                        out.write(redact(line.decode('utf-8', 'replace')) + '\n')
                    out.flush()
                if reason: break
            if not reason:
                out.write(redact(pending.decode('utf-8', 'replace')))
    finally:
        selector.close()
        try: os.killpg(p.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        except PermissionError:
            if p.poll() is None: raise
        try: p.wait(timeout=2)
        except subprocess.TimeoutExpired: pass
        # Kill descendants even when the group leader has exited.
        try: os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        except PermissionError:
            if p.poll() is None: raise
        p.wait()
        p.stdout.close()
    return p.returncode, reason

def events(path):
    sessions, calls, errors = set(), [], []
    for line in Path(path).read_text().splitlines():
        try: d = json.loads(line)
        except ValueError: continue
        if d.get('thread_id'): sessions.add(d['thread_id'])
        if d.get('session_id'): sessions.add(d['session_id'])
        item = d.get('item', {})
        if item.get('type') == 'mcp_tool_call' and d.get('type') == 'item.completed':
            calls.append({'tool': item.get('tool'), 'server': item.get('server'), 'status': item.get('status')})
            if item.get('error') or item.get('status') == 'failed': errors.append('mcp_call_failed')
        for content in (d.get('message') or {}).get('content', []) if isinstance((d.get('message') or {}).get('content', []), list) else []:
            if not isinstance(content, dict): continue
            if content.get('type') == 'tool_use': calls.append({'tool': content.get('name')})
            if content.get('is_error'): errors.append('tool_result_error')
        if d.get('is_error') or d.get('type') in ('error', 'turn.failed'): errors.append('client_error')
    return {'sessionIds': sorted(sessions), 'calls': calls, 'errors': errors}

def environment(root, client):
    env = os.environ.copy()
    # Keep model auth in native stores. Never import Merv bearer keys or ambient routing overrides.
    for key in list(env):
        if key.startswith(('MERV_', 'CLAUDE_CODE_', 'CODEX_')) or key in ('ANTHROPIC_BASE_URL','OPENAI_BASE_URL'):
            env.pop(key)
    env['CODEX_HOME' if client == 'codex' else 'CLAUDE_CONFIG_DIR'] = str(root / client / 'config')
    return env

def command(client, session=None):
    if client == 'codex':
        args = ['codex', '-a', 'on-request', 'exec', '--json', '--skip-git-repo-check']
        if session: args += ['resume', session]
        else: args += ['-s', 'workspace-write']
    else:
        args = ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'manual', '--permission-prompts', 'none', '--max-budget-usd', '2']
        if session: args += ['--resume', session]
    return args

def scenarios(): return read(HERE / 'scenarios.json')

def init(args):
    root = Path(args.root).resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    for client in ('codex', 'claude'):
        for directory in ('config', 'work', 'proof'):
            (root / client / directory).mkdir(parents=True, mode=0o700)
        shutil.copytree(HERE / 'fixtures', root / client / 'work' / 'fixtures')
        # Only a symlink to existing model authentication; never read/copy auth bytes.
        if client == 'codex' and args.codex_auth:
            auth = Path(args.codex_auth).expanduser().resolve()
            if not auth.is_file(): raise ValueError('Model authentication file does not exist')
            (root / client / 'config' / 'auth.json').symlink_to(auth)
        envvar = 'CODEX_HOME' if client == 'codex' else 'CLAUDE_CONFIG_DIR'
        launcher = root / client / 'interactive.sh'
        launcher.write_text('#!/bin/sh\ncd ' + shlex.quote(str(root/client/'work')) + '\nexport ' + envvar + '=' + shlex.quote(str(root/client/'config')) + '\nexec ' + client + ' "$@"\n')
        launcher.chmod(0o700)
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
    write(root/'run.json', {'schemaVersion':1, 'runId':str(uuid.uuid4()), 'createdAt':now(), 'candidateRevision':revision, 'deployedRevision':args.deployed_revision, 'url':args.url, 'projectId':args.project_id, 'scope':'synthetic acceptance only'})
    print(root)

def run(args):
    root = Path(args.root).resolve(); meta = read(root/'run.json')
    scenario = next(s for s in scenarios() if s['id'] == args.scenario)
    proof = root/args.client/'proof'
    previous = sorted(p for p in proof.glob(args.scenario + '-*.json') if not p.name.endswith('.attestation.json'))
    if previous and not args.resume:
        raise ValueError('Scenario already attempted; inspect receipts and use --resume SESSION_ID, never blindly recreate')
    if args.resume and not any(args.resume in (read(p).get('sessionIds', []) or (events(p.with_suffix('.jsonl'))['sessionIds'] if p.with_suffix('.jsonl').exists() else [])) for p in previous):
        raise ValueError('Resume session must be recorded for this scenario/client')
    attempt = len(previous)+1; stem = f'{args.scenario}-{attempt:03}'
    prompt = f'''Use Merv via its installed native plugin/MCP tools. Run ID {meta['runId']}; project {meta['projectId']}; URL {meta['url']}. Scenario {scenario['id']}.
{scenario['prompt']}
Only touch this designated synthetic project. Read current state and existing receipts before creating anything; use stable request IDs where supported. Never bypass permissions, consent, roles, leases, independent review or revision gates. Never print/read credential stores or put secrets in evidence. No direct HTTP substitute for agent tools. No paid provisioning or enabling dispatch: report blocked unless the operator has separately configured an already-authorized worker. Do not approve your own work or invent evidence. Fixture is fixtures/seeded_mean.py. Bound local CPU work to 10 seconds, no GPU, no packages. Record IDs, revisions, actual checks and cleanup required in your final answer. Stop at genuine human approval or auth requirements and report blocked.
'''
    if args.resume:
        prompt += '\nResume existing work only. Recover state using retained IDs before any mutation. Previous redacted evidence is outside this workspace; ask the operator for missing IDs rather than recreating.\n'
    argv = command(args.client, args.resume) + [prompt]
    if args.dry_run:
        print(json.dumps({'argv':argv, 'cwd':str(root/args.client/'work'), 'checks':scenario['checks']})); return
    # Exclusive attempt marker prevents concurrent duplicate launches and survives interruption.
    ledger = proof/(stem+'.json')
    with ledger.open('x') as f: json.dump({**meta,'scenario':args.scenario,'client':args.client,'status':'blocked','reason':'interrupted_or_running','sessionIds':[]}, f)
    started = now(); log = proof/(stem+'.jsonl')
    env = environment(root,args.client)
    version = subprocess.run([args.client,'--version'],env=env,capture_output=True,text=True,timeout=10,check=True).stdout.strip()
    code, reason = capture(argv, env, root/args.client/'work', log, args.timeout)
    parsed = events(log)
    write(ledger, {**meta, 'scenario':args.scenario,'client':args.client,'clientVersion':version,'startedAt':started,'finishedAt':now(), 'attempt':attempt,'resumeOf':args.resume, **parsed, 'exitCode':code, 'status':'blocked' if reason or code == 0 else 'fail', 'reason':reason or ('evidence_review_required' if code == 0 else 'client_exit'), 'proofPaths':[str(log)], 'proofSha256':hashlib.sha256(log.read_bytes()).hexdigest(), 'workflowIds':[], 'receiptIds':[], 'cleanup':{'status':'pending','notes':'Retain synthetic resources until evidence review; inspect active workers before cleanup.'}, 'checks':{c:None for c in scenario['checks']}})
    print(ledger)
    return 0 if code == 0 and not reason else 1

def attest(args):
    ledger = Path(args.ledger).resolve(); row = read(ledger); verdict = read(args.evidence)
    if verdict.get('status') not in ('pass','fail','blocked'): raise ValueError('Invalid verdict')
    checks = verdict.get('checks',{})
    if set(checks) != set(row['checks']): raise ValueError('Every scenario check needs explicit evidence')
    proofs = []
    for check, evidence in checks.items():
        if evidence.get('status') not in ('pass','fail','blocked'): raise ValueError('Invalid check status')
        if verdict['status'] == 'pass' and evidence['status'] != 'pass': raise ValueError('Cannot pass incomplete checks')
        if not evidence.get('observation'): raise ValueError('Observation required')
        for value in evidence.get('proofPaths',[]):
            p = Path(value).resolve()
            if not p.is_relative_to(ledger.parent) or not p.is_file(): raise ValueError('Proof must be a file inside this client proof directory')
            proofs.append({'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
        if evidence['status']=='pass' and not evidence.get('proofPaths'): raise ValueError('Pass requires retained proof')
    if not all(k in verdict for k in ('workflowIds','receiptIds')): raise ValueError('Explicit workflowIds and receiptIds arrays required, empty only if inapplicable')
    if not verdict.get('reviewer') or not verdict.get('cleanup'): raise ValueError('Reviewer and cleanup required')
    if verdict['status']=='pass' and (row['exitCode'] != 0 or row['reason'] != 'evidence_review_required' or row['errors']): raise ValueError('Resolve client errors before passing')
    write(ledger.with_suffix('.attestation.json'), {**verdict,'runId':row['runId'],'scenario':row['scenario'],'client':row['client'],'attestedAt':now(),'proofs':proofs,'ledgerSha256':hashlib.sha256(ledger.read_bytes()).hexdigest()})

def inventory(args):
    # Source candidates plus frozen worker metadata: neither substitutes for live discovery.
    tools = {}
    for p in (REPO/'merv-typescript/packages').glob('*/src/*tools*.ts'):
        for name in re.findall(r"(?:\.noun\(|\.register\(\s*\{\s*name:\s*)['\"]([a-z][a-z_]*(?:\.[a-z_]+)+)['\"]", p.read_text()):
            tools.setdefault(name,[]).append(str(p.relative_to(REPO)))
    metadata = read(REPO/'merv-typescript/tests/fixtures/tool-metadata.json')
    for surface, entries in metadata.items():
        if isinstance(entries,dict):
            for name in entries: tools.setdefault(name,[]).append('snapshot:'+surface)
    result=[]
    for name, sources in sorted(tools.items()):
        covered=[s['id'] for s in scenarios() if name.split('.')[0] in s['areas']]
        result.append({'tool':name,'sources':sources,'scenarios':covered,'status':'not_run','coverage':'area_only' if covered else 'unmapped'})
    write(args.output, {'generatedAt':now(),'warning':'Static candidates/legacy snapshots; reconcile with live tools and noun action schemas after deployment. Area mapping is not action coverage.','tools':result,'scenarios':scenarios()})
    print(f'{len(result)} tool candidates; {sum(not r["scenarios"] for r in result)} unmapped')

def preflight(args):
    result = {'checkedAt': now(), 'clients': {}, 'status': 'pass'}
    required = {'codex': ['--json','--skip-git-repo-check','--sandbox'], 'claude': ['--output-format','--permission-mode','--permission-prompts','--max-budget-usd','--resume']}
    for client in required:
        try:
            version = subprocess.check_output([client,'--version'], text=True, timeout=10).strip()
            helptext = subprocess.check_output([client, *(['exec'] if client=='codex' else []), '--help'],text=True,timeout=10)
            missing = [f for f in required[client] if f not in helptext]
            result['clients'][client] = {'version':version, 'missingFlags':missing, 'status':'blocked' if missing else 'pass'}
        except (OSError,subprocess.SubprocessError):
            result['clients'][client] = {'status':'blocked','reason':'cli_unavailable'}
        if result['clients'][client]['status'] != 'pass': result['status']='blocked'
    write(args.output,result)
    print(json.dumps(result))
    return 0 if result['status']=='pass' else 1

def summary(args):
    root=Path(args.root).resolve(); rows=[]
    for client in ('codex','claude'):
        for scenario in scenarios():
            ledgers=sorted(p for p in (root/client/'proof').glob(scenario['id']+'-*.json') if not p.name.endswith('.attestation.json'))
            row={'client':client,'scenario':scenario['id'],'status':'not_run'}
            if ledgers:
                ledger=ledgers[-1]; data=read(ledger)
                row.update(status=data['status'],reason=data['reason'],ledger=str(ledger))
                att=ledger.with_suffix('.attestation.json')
                if att.exists():
                    verdict=read(att)
                    valid=verdict['ledgerSha256']==hashlib.sha256(ledger.read_bytes()).hexdigest()
                    for proof in verdict['proofs']:
                        p=Path(proof['path'])
                        valid=valid and p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()==proof['sha256']
                    row.update(status=verdict['status'] if valid else 'blocked',reason='attested' if valid else 'evidence_changed',attestation=str(att))
            rows.append(row)
    write(root/'summary.json',{'schemaVersion':1,'run':read(root/'run.json'),'generatedAt':now(),'status':'pass' if all(r['status']=='pass' for r in rows) else 'blocked','scenarios':rows})
    print(root/'summary.json')

def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__); sub=parser.add_subparsers(dest='cmd',required=True)
    p=sub.add_parser('preflight'); p.add_argument('output'); p.set_defaults(fn=preflight)
    p=sub.add_parser('summary'); p.add_argument('root'); p.set_defaults(fn=summary)
    p=sub.add_parser('init'); p.add_argument('root'); p.add_argument('--url',required=True); p.add_argument('--project-id',required=True); p.add_argument('--deployed-revision',required=True); p.add_argument('--codex-auth'); p.set_defaults(fn=init)
    p=sub.add_parser('run'); p.add_argument('root'); p.add_argument('--client',choices=['codex','claude'],required=True); p.add_argument('--scenario',choices=[s['id'] for s in scenarios()],required=True); p.add_argument('--resume'); p.add_argument('--dry-run',action='store_true'); p.add_argument('--timeout',type=int,default=600); p.set_defaults(fn=run)
    p=sub.add_parser('attest'); p.add_argument('ledger'); p.add_argument('evidence'); p.set_defaults(fn=attest)
    p=sub.add_parser('inventory'); p.add_argument('output'); p.set_defaults(fn=inventory)
    args=parser.parse_args()
    if hasattr(args,'timeout') and not 1<=args.timeout<=1800: parser.error('timeout must be 1..1800 seconds')
    try: return args.fn(args) or 0
    except (ValueError,OSError,subprocess.SubprocessError) as e:
        print(redact(str(e)),file=sys.stderr); return 2

if __name__=='__main__': sys.exit(main())
