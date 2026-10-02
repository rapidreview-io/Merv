import hashlib
import http.server
import json
import os
from pathlib import Path
import secrets
import shlex
import signal
import subprocess
import threading
import time


enrollment = 'me_' + secrets.token_hex(32)
model_key = 'sk-test-' + secrets.token_hex(32)
session = 'ms_' + secrets.token_urlsafe(32)
hf_token = 'hf_' + secrets.token_hex(20)
hf_endpoint = 'https://experiments.rapidreview.io/hf'
hf_digest = hashlib.sha256(hf_token.encode()).hexdigest()
enrolled = threading.Event()
# The top-level keys and tool types fleet/src/codex-relay.ts admits: a Codex that sends others fails here.
KEYS = {'model', 'instructions', 'input', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning',
        'store', 'stream', 'include', 'prompt_cache_key', 'text', 'client_metadata'}
TOOLS = {'function', 'custom', 'local_shell', 'namespace'}
# Run by Codex as the assignment identity: may it read the environment that holds its bearer, and
# does the hosted profile give its shell the network (here only loopback: this Main's port)?
PROBE = ("for f in /proc/[0-9]*/environ; do tr '\\0' '\\n' <\"$f\" 2>/dev/null | "
         "grep -q '^MERV_AGENT_SESSION_TOKEN=' && echo \"readable $f\"; done; python3 -c "
         "\"import socket; socket.create_connection(('127.0.0.1', %d), 5)\" && echo network-on; "
         "echo \"uid $(id -u) probe-done\"")
probe_suffix = ''


def probe_command(port):
    return (PROBE % port) + ("; python3 -c \"import os,hashlib; "
          "assert hashlib.sha256(os.environ.get('HF_TOKEN','').encode()).hexdigest() == '" + hf_digest + "'; "
          "assert os.environ.get('HF_ENDPOINT') == '" + hf_endpoint + "'; assert 'MERV_AGENT_SESSION_TOKEN' not in os.environ; print('hf-token-inherited')\"") + probe_suffix
calls, outputs, holders, relay_credentials = [], [], set(), []


def environ(pid):
    try:
        return Path(f'/proc/{pid}/environ').read_bytes()
    except OSError:
        return b''


class Main(http.server.BaseHTTPRequestHandler):
    """Main as the machine sees it: managed enrollment, and the relay's /codex-model route."""

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length', '0'))) or b'{}')
        if self.path == '/sessions/runners/enroll':
            if (self.headers.get('authorization') == 'Bearer ' + enrollment and
                    self.headers.get('x-merv-project-id') == 'project_workflow_gate' and
                    isinstance(body.get('workerNonce'), str) and len(body['workerNonce']) == 64):
                enrolled.set()
            self.send_response(503)
            self.end_headers()
            return
        current_credential = self.headers.get('authorization') == 'Bearer ' + session
        relay_credentials.append(current_credential)
        if not current_credential:
            self.send_response(401)
            self.end_headers()
            return
        tools = body.get('tools', [])
        calls.append((self.command, self.path, sorted(body), {t.get('type') for t in tools} |
                      {t.get('type') for n in tools for t in n.get('tools', [])}))
        answered = [i['output'] for i in body.get('input', []) if i.get('type') == 'function_call_output']
        if answered:
            outputs.extend(answered)
            # The bearer is there to find: its own uid, outside Codex's sandbox, reads it.
            holders.update(subprocess.run(
                ['/usr/bin/grep', '-lsaFf', '-', *map(str, Path('/proc').glob('[0-9]*/environ'))],
                input=session.encode(), capture_output=True, user=12001, group=12001, extra_groups=[],
            ).stdout.split())
        item = ({'type': 'message', 'role': 'assistant', 'id': 'msg_gate',
                 'content': [{'type': 'output_text', 'text': 'done'}]} if answered else
                {'type': 'function_call', 'name': 'exec_command', 'call_id': 'probe',
                 'arguments': json.dumps({'cmd': probe_command(self.server.server_port)})})
        events = [{'type': 'response.created', 'response': {'id': 'resp_gate'}},
                  {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
                  {'type': 'response.completed', 'response': {'id': 'resp_gate', 'usage': {
                      'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}}]
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()
        self.wfile.write(''.join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode())

    def do_GET(self):
        calls.append((self.command, self.path, [], set()))
        self.send_response(404)
        self.end_headers()

    def log_message(self, *_args):
        pass


def supervise(bootstrap):
    filename = Path('/run/merv-runtime/bootstrap-workflow-gate')
    filename.write_text(json.dumps({
        'baseUrl': base, 'projectId': 'project_workflow_gate', 'enrollmentToken': enrollment, **bootstrap}))
    filename.chmod(0o600)
    return filename, subprocess.Popen(
        ['/opt/merv/runtime/start-runner'],
        env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'MERV_BOOTSTRAP_FILE': str(filename)},
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=True,
    )


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Main)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
base = f'http://127.0.0.1:{server.server_port}'
# A bootstrap that still carries a provider key is an old owner's: the supervisor refuses it whole.
filename, refused = supervise({'modelApiKey': model_key})
refused_output = b''.join(refused.communicate(timeout=30))
assert refused.returncode != 0 and not enrolled.is_set() and not filename.exists()
filename, parent = supervise({})
try:
    assert enrolled.wait(30), 'fixed workflow supervisor did not reach managed enrollment'
    assert parent.poll() is None
    assert not filename.exists()
    command = Path(f'/proc/{parent.pid}/cmdline').read_bytes()
    assert command.split(b'\x00')[:2] == [b'/usr/local/bin/node', b'/opt/merv/runner/smoke-supervisor.mjs']
    assert enrollment.encode() not in command + environ(parent.pid)
finally:
    if parent.poll() is None:
        os.killpg(parent.pid, signal.SIGTERM)
    try:
        output, error = parent.communicate(timeout=8)
    except subprocess.TimeoutExpired:
        os.killpg(parent.pid, signal.SIGKILL)
        parent.communicate()
        raise RuntimeError('workflow supervisor failed to stop')
# Codex as the hosted profile launches it, through the fixed assignment launcher and identity drop.
work = Path('/workspace/assignments') / secrets.token_hex(32)
work.mkdir(mode=0o700)
# The hosted profile's own settings (runner/src/profiles.ts), but for Merv's MCP server.
settings = ['approval_policy="never"', 'model_reasoning_effort="low"', 'web_search="disabled"', 'features.shell_tool=true',
            'features.multi_agent=false', 'features.shell_snapshot=false', 'allow_login_shell=false',
            'shell_environment_policy.inherit="all"', 'shell_environment_policy.include_only=["PATH","HOME","USER","TMPDIR","LANG","HF_TOKEN","HF_ENDPOINT"]', 'shell_environment_policy.ignore_default_excludes=true',
            'shell_environment_policy.experimental_use_profile=false',
            'shell_environment_policy.set={"PATH"="/usr/bin:/bin","HOME"="/home/assignment",'
            '"USER"="assignment","TMPDIR"="/tmp","LANG"="C.UTF-8"}',
            'sandbox_workspace_write.network_access=true', 'model_provider="merv"',
            'model_providers.merv={"name"="Merv","base_url"="%s/codex-model",'
            '"env_key"="MERV_AGENT_SESSION_TOKEN","wire_api"="responses"}' % base]
def codex(sandbox):
    calls.clear(), outputs.clear(), holders.clear(), relay_credentials.clear()
    return subprocess.run(
        ['/usr/bin/python3', '-c', "import sys; sys.path.insert(0, '/opt/merv/python'); "
         'from merv_sandboxes.runtimes import assignment; sys.exit(assignment.main())',
         '--', '/opt/merv/bin/codex', 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral',
         '--skip-git-repo-check', '--sandbox', sandbox, '--json', '-C', str(work),
         *[part for setting in settings for part in ('-c', setting)], '--model', 'gpt-6.1-sol', '-'],
        cwd=work, input=b'Run the probe, then stop.', capture_output=True, timeout=120,
        env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'MERV_AGENT_SESSION_TOKEN': session,
             'MERV_MCP_URL': f'{base}/mcp', 'HF_TOKEN': hf_token, 'HF_ENDPOINT': hf_endpoint},
    )


def checked_launch():
    launch = codex('workspace-write')
    # Some release hosts refuse Codex's unprivileged namespaces. Report the
    # fallback accurately; the live hosted canary must prove the actual sandbox.
    sandboxed = 'No permissions to create a new namespace' not in ''.join(outputs)
    if not sandboxed:
        transcripts.append(launch.stdout + launch.stderr)
        launch = codex('danger-full-access')
    probe = ''.join(outputs)
    home_files = [p for p in Path('/home/assignment/.codex').rglob('*') if p.is_file()]
    assert launch.returncode == 0 and len(calls) >= 2, 'hosted Codex did not finish through the relay'
    assert relay_credentials and all(relay_credentials), 'Codex used a stale session credential'
    assert all(c[:2] == ('POST', '/codex-model/responses') and set(c[2]) <= KEYS and c[3] <= TOOLS
               for c in calls), calls
    assert 'uid 12001 probe-done' in probe, probe
    assert not sandboxed or ('readable ' not in probe and holders), probe
    assert 'network-on' in probe and 'hf-token-inherited' in probe, probe
    assert hf_token not in json.dumps(settings)
    assert not any(hf_token.encode() in p.read_bytes() for p in home_files)
    assert not any(p.name == 'auth.json' or session.encode() in p.read_bytes() for p in home_files)
    request_keys.update(k for c in calls for k in c[2])
    transcripts.append(launch.stdout + launch.stderr)
    return sandboxed, probe


def reset():
    result = subprocess.run(
        ['/usr/bin/python3', '/opt/merv/python/merv_sandboxes/runtimes/assignment.py', '--reset'],
        env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'},
        stdin=subprocess.DEVNULL, capture_output=True, timeout=15,
    )
    assert result.returncode == 0, 'retained workflow reset refused'


def private_state_canaries():
    # A detached assignment-UID fixture stands in for an escaped shell child.
    # It runs outside Codex's sandbox deliberately: reset must stop this too.
    code = """import os,time
from pathlib import Path
os.setsid()
if os.fork(): os._exit(0)
Path('/home/assignment/.codex/gate-private').write_text('old-private-config')
Path('/tmp/merv-workflow-gate-private').write_text('old-private-token')
Path('gate-descendant').write_text(str(os.getpid()))
while True: time.sleep(1)
"""
    starter = subprocess.Popen(
        ['/usr/bin/python3', '-c', code], cwd=work,
        env={'PATH': '/usr/bin:/bin'}, user=12001, group=12001, extra_groups=[],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    assert starter.wait(timeout=5) == 0
    deadline = time.monotonic() + 5
    while not (work / 'gate-descendant').exists():
        assert time.monotonic() < deadline, 'detached fixture did not start'
        time.sleep(0.01)
    pid = int((work / 'gate-descendant').read_text())
    reset()
    try:
        state = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()[0]
        assert state in ('Z', 'X'), 'escaped assignment process survived reset'
    except FileNotFoundError:
        pass
    assert not Path('/home/assignment/.codex/gate-private').exists()
    assert not Path('/tmp/merv-workflow-gate-private').exists()
    (work / 'gate-descendant').unlink()


request_keys, transcripts, sandbox_results = set(), [], []
secret_values = [enrollment, model_key, session, hf_token]
try:
    normal_sandbox, _ = checked_launch()
    sandbox_results.append(normal_sandbox)
    reset()
    for phase in range(2):
        session = 'ms_' + secrets.token_urlsafe(32)
        hf_token = 'hf_' + secrets.token_hex(20)
        hf_digest = hashlib.sha256(hf_token.encode()).hexdigest()
        secret_values.extend((session, hf_token))
        # Each real Codex shell observes the identical absolute cwd and the prior
        # phase's bytes, while home/temp state was discarded by the root helper.
        code = ("from pathlib import Path; import os; "
                f"assert os.getcwd()=={str(work)!r}; "
                "assert not Path('/home/assignment/.codex/gate-private').exists(); "
                "assert not Path('/tmp/merv-workflow-gate-private').exists(); "
                "p=Path('gate-retained-research'); "
                f"assert (p.read_text() if p.exists() else '')=={'phase-0' if phase else ''!r}; "
                f"p.write_text('phase-{phase}'); print('retained-phase-{phase}')")
        probe_suffix = '; python3 -c ' + shlex.quote(code)
        sandboxed, probe = checked_launch()
        sandbox_results.append(sandboxed)
        assert f'retained-phase-{phase}' in probe, probe
        assert (work / 'gate-retained-research').read_text() == f'phase-{phase}'
        private_state_canaries()
        assert (work / 'gate-retained-research').read_text() == f'phase-{phase}'
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
for secret in secret_values:
    assert secret.encode() not in output + error + refused_output + b''.join(transcripts)
sandboxed = all(sandbox_results)
print(json.dumps({
    'gate': 'linux-workflow-dispatch', 'fixedSupervisor': True, 'bootstrapWithModelKeyRefused': True,
    'managedEnrollmentReached': True, 'bootstrapRemoved': True, 'noCredentialInArgvOrEnvironment': True,
    'codexCalledOnlyTheRelay': True, 'codexRequestKeys': sorted(request_keys),
    'noCredentialFileInCodexHome': True, 'shellNetworkOn': True, 'hfTokenInheritedByShell': True, 'hfTokenAbsentFromArgsConfigAndLogs': True, 'codexSandboxOnHost': sandboxed,
    **({'sessionBearerUnreadableFromShell': True} if sandboxed else {}),
    'normalLaneExercised': True, 'retainedCodexLaunches': 2, 'retainedSameAbsoluteCwd': True,
    'retainedResearchPreserved': True, 'privateStateCanariesCleared': True,
    'detachedAssignmentDescendantsCleared': True, 'freshSessionCredentials': True,
    'codexSandboxPerLaunch': sandbox_results,
    # Local fake relay is incompatible with the probe's sole-sshd listener rule.
    # The release's separate exact-image isolation gate covers that boundary.
    'assignmentAttestation': 'separate exact-image isolation gate; not integrated here',
}))
