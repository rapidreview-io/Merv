"""Real Linux read-only mount + identity boundary. Run as root in the candidate image."""
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import secrets
import shlex
import stat
import threading
import tempfile

sys.path.insert(0, '/opt/merv/python')
sys.path.insert(0, '/opt/merv/runtime')
from merv_sandboxes.runtimes.launcher import prepare_assignment_identity

wrapper_path = Path(os.environ.get('MERV_REVIEW_WRAPPER', '/opt/merv/runtime/assignment-probed.py'))
sys.path.insert(0, str(wrapper_path.parent))
spec = importlib.util.spec_from_file_location('review_boundary', wrapper_path)
wrapper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wrapper)


def git(path, *args):
    return subprocess.run(['/usr/bin/git', '-C', str(path), *args], check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode().strip()


if len(sys.argv) > 1 and sys.argv[1] == '--codex':
    # Synthetic local ancestry only. The workflow gate independently verifies
    # attest_workflow through supervisor -> guardian -> launcher. Here all of
    # assignment.main, the RO mount, identity drop, and Codex sandbox run unchanged.
    wrapper.attest_workflow = lambda cwd: None
    sys.argv = [str(wrapper_path), *sys.argv[2:]]
    raise SystemExit(wrapper.main())
elif len(sys.argv) > 1:
    path = Path(sys.argv[1])
    wrapper.readonly_code(path)
    prepare_assignment_identity(uid=12001, gid=12001, administrative_uid=1000, preserve_stdio=True)
    assert os.getuid() == 12001
    assert git(path, 'show', 'HEAD:source.txt') == 'original'
    assert (path / 'source.txt').read_text() == 'submitted without commit\n'
    for target in [path / 'source.txt', path / 'new.txt', path / '.git/config', path / '.git/HEAD']:
        try:
            target.write_text('tampered')
            raise AssertionError('review file was writable: ' + str(target))
        except OSError:
            pass
    for command in [['add', '-A'], ['reset', '--hard', 'HEAD'], ['checkout', '-b', 'review-write'],
                    ['config', 'review.changed', 'true'], ['update-ref', 'refs/heads/review', 'HEAD']]:
        assert subprocess.run(['/usr/bin/git', '-C', str(path), *command],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0
    assert subprocess.run(['/usr/bin/mount', '-o', 'remount,rw,bind', str(path)],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0
    try:
        (path.parent / 'runner-private' / 'credential').read_text()
        raise AssertionError('reviewer read runner credential')
    except PermissionError:
        pass
    with tempfile.TemporaryDirectory(prefix='review-scratch-') as scratch:
        output = Path(scratch) / 'test-output'
        output.write_text('tests may write scratch')
        assert output.read_text() == 'tests may write scratch'
    status = Path('/proc/self/status').read_text()
    for field in ['CapEff', 'CapPrm', 'CapBnd', 'CapAmb']:
        assert int(status.split(field + ':')[1].split()[0], 16) == 0
    assert 'NoNewPrivs:\t1' in status
else:
    assert sys.platform == 'linux' and os.geteuid() == 0
    with tempfile.TemporaryDirectory(prefix='review-gate-', dir='/var/tmp') as temporary:
        root = Path(temporary)
        root.chmod(0o755)
        private = root / 'runner-private'
        private.mkdir(mode=0o700)
        (private / 'credential').write_text('synthetic-runner-secret')
        path = root / 'checkout'
        path.mkdir()
        git(path, 'init', '-q')
        git(path, 'config', 'user.name', 'Fixture')
        git(path, 'config', 'user.email', 'fixture@example.invalid')
        (path / 'source.txt').write_text('original\n')
        git(path, 'add', '.')
        git(path, 'commit', '-qm', 'parent')
        (path / 'source.txt').write_text('submitted without commit\n')
        # This matches the real handoff: assignment-owned, otherwise writable checkout.
        for directory, dirs, files in os.walk(path):
            os.chown(directory, 12001, 12001)
            for name in dirs + files:
                os.chown(Path(directory) / name, 12001, 12001)
        subprocess.run([sys.executable, __file__, str(path)], check=True)
        # Child's private mount did not freeze the supervisor's retained working copy.
        (path / 'source.txt').write_text('supervisor can prepare the next session\n')

    # Continue below through the real Codex tool, using the image's production
    # runner arguments. A final model message or process exit is not evidence.

if len(sys.argv) == 1:
    # The server supplies one advertised tool call and observes its output. No model
    # account, network outside loopback, real project, or hosted credential is used.
    outputs, failures, transcripts, holders = [], [], [], []
    session, git_token = '', ''
    command = ''

    class Main(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            try:
                assert self.headers.get('authorization') == 'Bearer ' + session
                body = json.loads(self.rfile.read(int(self.headers.get('content-length', '0'))))
                if self.path == '/mcp':
                    if 'id' not in body:
                        self.send_response(202)
                        self.end_headers()
                        return
                    result = ({'protocolVersion': body['params']['protocolVersion'], 'capabilities': {'tools': {}},
                               'serverInfo': {'name': 'merv', 'version': 'gate'}} if body['method'] == 'initialize'
                              else {'tools': []} if body['method'] == 'tools/list' else {})
                    raw = json.dumps({'jsonrpc': '2.0', 'id': body['id'], 'result': result}).encode()
                    self.send_response(200)
                    self.send_header('content-type', 'application/json')
                else:
                    assert self.path == '/codex-model/responses'
                    tools = body.get('tools', []) + [t for i in body.get('input', [])
                        if i.get('type') == 'additional_tools' for t in i.get('tools', [])]
                    declared = tools + [t for n in tools for t in n.get('tools', [])]
                    assert any(t.get('type') == 'custom' and t.get('name') == 'exec' and
                               'exec_command(' in t.get('description', '') for t in declared)
                    answered = [''.join(p.get('text', '') for p in i['output']) if isinstance(i['output'], list)
                                else i['output'] for i in body.get('input', []) if i.get('type') == 'custom_tool_call_output']
                    if answered:
                        outputs.extend(answered)
                        # Positive control outside Codex's sandbox: the same UID can
                        # read an environment containing the current synthetic bearer.
                        visible = subprocess.run(['/usr/bin/grep', '-lsaFf', '-',
                            *map(str, Path('/proc').glob('[0-9]*/environ'))], input=session.encode(),
                            capture_output=True, user=12001, group=12001, extra_groups=[])
                        holders.append(bool(visible.stdout))
                    item = ({'type': 'message', 'role': 'assistant', 'id': 'msg_gate',
                             'content': [{'type': 'output_text', 'text': 'done'}]} if answered else
                            {'type': 'custom_tool_call', 'name': 'exec', 'call_id': 'probe', 'input':
                             'const r = await tools.exec_command(%s); text(r);' % json.dumps(
                                 {'cmd': command, 'yield_time_ms': 30000, 'max_output_tokens': 4000})})
                    events = [{'type': 'response.created', 'response': {'id': 'resp_gate'}},
                              {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
                              {'type': 'response.completed', 'response': {'id': 'resp_gate', 'usage': {
                                  'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}}]
                    raw = ''.join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()
                    self.send_response(200)
                    self.send_header('content-type', 'text/event-stream')
                self.send_header('content-length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            except Exception as error:
                failures.append(type(error).__name__)
                self.send_response(500)
                self.end_headers()

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Main)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    endpoint = f'http://127.0.0.1:{server.server_port}'
    work = Path('/workspace/assignments') / secrets.token_hex(32)
    work.mkdir(mode=0o700)
    private = Path('/run/reviewer-gate-private')
    private.mkdir(mode=0o700)
    (private / 'credential').write_text('synthetic-private-credential')
    git(work, 'init', '-q')
    git(work, 'config', 'user.name', 'Fixture')
    git(work, 'config', 'user.email', 'fixture@example.invalid')
    (work / 'source.txt').write_text('original\n')
    git(work, 'add', '.')
    git(work, 'commit', '-qm', 'parent')
    commit = git(work, 'rev-parse', 'HEAD')
    (work / 'source.txt').write_text('submitted without commit\n')
    # No .agents/.codex/.aws; reproduces the actual hosted design review failure.
    protected = ['.git', '.agents', '.codex', '.aws']
    initial = subprocess.run(['/usr/bin/git', '-C', str(work), 'status', '--porcelain=v1'],
                             capture_output=True, check=True).stdout.decode()
    assert initial == ' M source.txt\n'

    def inventory():
        result = {}
        for p in [work, *work.rglob('*')]:
            info = p.lstat()
            content = ('link', os.readlink(p)) if p.is_symlink() else ('dir',) if p.is_dir() else (
                'file', hashlib.sha256(p.read_bytes()).hexdigest())
            result[str(p.relative_to(work))] = (stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid, *content)
        return result

    probe = r'''import ctypes, errno, json, os, subprocess, tempfile
from pathlib import Path
p=Path.cwd()
assert os.getuid()==12001
assert p.name==WORK_NAME
assert Path('/proc/self/status').read_text().split('NoNewPrivs:')[1].split()[0]=='1'
for field in ['CapEff','CapPrm','CapBnd','CapAmb']:
    assert int(Path('/proc/self/status').read_text().split(field+':')[1].split()[0],16)==0
assert not any(k.startswith(('MERV_', 'GIT_CONFIG_')) for k in os.environ)
for environ in Path('/proc').glob('[0-9]*/environ'):
    try: raw=environ.read_bytes()
    except OSError: continue
    assert b'MERV_AGENT_SESSION_TOKEN=' not in raw and b'MERV_GIT_TOKEN=' not in raw
try: Path('/run/reviewer-gate-private/credential').read_bytes()
except PermissionError: pass
else: raise AssertionError('root credential readable')
assert (p/'source.txt').read_text()=='submitted without commit\n'
def git(*args):
    return subprocess.run(['/usr/bin/git',*args],capture_output=True,text=True)
assert git('show','HEAD:source.txt').stdout=='original\n'
assert git('rev-parse','HEAD').stdout.strip()==COMMIT
assert git('status','--porcelain=v1').stdout==STATUS
for target in ['source.txt','new.txt','.git/config','.git/HEAD','.git/refs/heads/blocked',*PROTECTED]:
    q=p/target
    if q.is_dir(): q=q/'blocked'
    try: q.write_text('tampered')
    except OSError as e: assert e.errno in (errno.EROFS,errno.EACCES,errno.EPERM)
    else: raise AssertionError('writable '+target)
for args in [('add','-A'),('reset','--hard','HEAD'),('checkout','-b','blocked'),
             ('config','review.changed','true'),('update-ref','refs/heads/blocked','HEAD')]:
    assert git(*args).returncode!=0, args
try: os.setuid(0)
except OSError as e:
    # bwrap maps only the assignment UID: 0 may be unmapped (EINVAL),
    # or mapped but forbidden (EPERM). Neither may change the identity.
    assert e.errno in (errno.EPERM,errno.EINVAL) and os.getuid()==12001
else: raise AssertionError('root identity acquired')
for action in [lambda: (p/'source.txt').unlink(),
               lambda: (p/'.git/HEAD').rename(p/'.git/replaced')]:
    try: action()
    except OSError as e: assert e.errno in (errno.EROFS,errno.EACCES,errno.EPERM)
    else: raise AssertionError('mutation or privilege escalation succeeded')
for args in [['/usr/bin/mount','-o','remount,rw,bind',str(p)],
             ['/usr/bin/unshare','-Ur','-m','/bin/sh','-c','mount -o remount,rw,bind . && touch escaped']]:
    assert subprocess.run(args,capture_output=True).returncode!=0
assert not Path('/tmp/reviewer-reuse-canary').exists()
assert not Path('/home/assignment/.codex/reviewer-reuse-canary').exists()
assert os.environ['XDG_CACHE_HOME']=='/tmp/cache'
assert os.environ['UV_CACHE_DIR']=='/tmp/cache/uv'
with tempfile.TemporaryDirectory(prefix='review-codex-') as tmp:
    q=Path(tmp)/'output';q.write_text('scratch');assert q.read_text()=='scratch'
Path('/tmp/reviewer-reuse-canary').write_text('previous visit')
try: Path('/home/assignment/outside-write').write_text('tampered')
except OSError as e: assert e.errno in (errno.EROFS,errno.EACCES,errno.EPERM)
else: raise AssertionError('sandbox allowed a home write')
print('review-shell-ok:KIND')
'''
    try:
        for index, kind in enumerate(['plan', 'results', 'task']):
            if index == 1:
                # Existing protected directories with content must also stay byte-identical.
                for name in protected[1:]:
                    (work / name).mkdir()
                    (work / name / 'evidence').write_text('submitted protected content\n')
                # Submitted repo config must not broaden the trusted launch profile.
                (work / '.codex/config.toml').write_text(
                    '[permissions.merv-review.filesystem]\n"/home/assignment" = "write"\n')
            elif index == 2:
                # Missing .agents plus a regular .codex and in-tree .aws symlink:
                # no sandbox placeholder may replace or follow them to gain writes.
                (work / '.codex/config.toml').unlink()
                for name in protected[1:]:
                    (work / name / 'evidence').unlink()
                    (work / name).rmdir()
                (work / '.codex').write_text('submitted file\n')
                (work / '.aws').symlink_to('source.txt')
            for directory, dirs, files in os.walk(work):
                os.chown(directory, 12001, 12001)
                for name in dirs + files:
                    os.chown(Path(directory) / name, 12001, 12001, follow_symlinks=False)
            # Obtain the submitted status as assignment, without refreshing the index.
            status = subprocess.run(['/usr/bin/git', '--no-optional-locks', '-C', str(work),
                                     'status', '--porcelain=v1'], capture_output=True, check=True,
                                    user=12001, group=12001, extra_groups=[]).stdout.decode()
            before = inventory()
            session, git_token = 'ms_' + secrets.token_urlsafe(32), 'mg_' + secrets.token_urlsafe(32)
            request = dict(kind=kind, cwd=str(work), endpoint=endpoint, secret=session,
                           gitToken=git_token, commit=commit)
            fixture = subprocess.run(['/usr/local/bin/node', '/opt/merv/runtime/review-launch-fixture.mjs'],
                                     input=json.dumps(request).encode(), capture_output=True, check=True)
            launch = json.loads(fixture.stdout)
            assert launch['policy']['readOnly'] and launch['policy']['workspace']['retain'] is False
            assert launch['env']['MERV_REVIEW_CODE'] == '1'
            assert '--sandbox' not in launch['args'] and not any('sandbox_workspace_write.' in a for a in launch['args'])
            body = probe.replace('WORK_NAME', repr(work.name)).replace('COMMIT', repr(commit)).replace(
                'STATUS', repr(status)).replace('PROTECTED', repr(protected)).replace('KIND', kind)
            command = '/usr/bin/python3 -I -c ' + shlex.quote(body)
            outputs.clear(), holders.clear()
            result = subprocess.run([sys.executable, __file__, '--codex', *launch['args']], cwd=work,
                                    env=launch['env'], input=launch['stdin'].encode(), capture_output=True, timeout=90)
            transcripts.append(result.stdout + result.stderr)
            assert result.returncode == 0 and not failures, 'Codex reviewer launch failed'
            assert outputs and f'review-shell-ok:{kind}' in ''.join(outputs), ''.join(outputs)
            # A completion message cannot pass a failed tool command or a skipped sandbox.
            assert '"exit_code":0' in ''.join(outputs).replace(' ', ''), ''.join(outputs)
            assert holders and all(holders), 'credential-read positive control unavailable'
            assert inventory() == before, 'Codex modified the submitted checkout or Git metadata'
            assert (work / '.agents').exists() == (index == 1), 'Codex created a missing protected target'
            for secret in [session, git_token]:
                assert secret.encode() not in result.stdout + result.stderr
                assert secret not in ''.join(outputs)
            # Root simulates previous private state; the supervisor's real reset must
            # erase it, while preserving the exact same checkout for the next visit.
            canary = Path('/home/assignment/.codex/reviewer-reuse-canary')
            canary.write_text('previous visit');os.chown(canary,12001,12001)
            reset = subprocess.run([str(wrapper_path), '--reset'], cwd='/', env={'PATH':'/usr/bin:/bin'},
                                   stdin=subprocess.DEVNULL, capture_output=True, timeout=20)
            assert reset.returncode == 0, 'same-host reset failed: ' + reset.stderr.decode()
            assert not canary.exists() and not Path('/tmp/reviewer-reuse-canary').exists()
            assert inventory() == before, 'same-host reset modified review evidence'
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    print(json.dumps({'gate': 'linux-review-readonly', 'passed': True,
        'actualCodexShell': True, 'readOnlyProfileWithScratch': True, 'snapshotUnchanged': True,
        'planResultsTaskReviewers': True, 'sameHostReset': True, 'credentialReadsDenied': True,
        'gitWritesAndPrivilegeEscapesDenied': True, 'protectedTargetsPreserved': True,
        'actualProtectedWorkflow': False, 'cloudflareEvidence': False}))
