import http.server
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import threading


enrollment = 'me_' + secrets.token_hex(32)
model_key = 'sk-test-' + secrets.token_hex(32)
session = 'ms_' + secrets.token_urlsafe(32)
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
calls, outputs, holders = [], [], set()


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
                 'arguments': json.dumps({'cmd': PROBE % self.server.server_port})})
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
settings = ['approval_policy="never"', 'web_search="disabled"', 'features.shell_tool=true',
            'features.multi_agent=false', 'features.shell_snapshot=false', 'allow_login_shell=false',
            'shell_environment_policy.inherit="none"', 'shell_environment_policy.ignore_default_excludes=false',
            'shell_environment_policy.experimental_use_profile=false',
            'shell_environment_policy.set={"PATH"="/usr/bin:/bin","HOME"="/home/assignment",'
            '"USER"="assignment","TMPDIR"="/tmp","LANG"="C.UTF-8"}',
            'sandbox_workspace_write.network_access=true', 'model_provider="merv"',
            'model_providers.merv={"name"="Merv","base_url"="%s/codex-model",'
            '"env_key"="MERV_AGENT_SESSION_TOKEN","wire_api"="responses"}' % base]
def codex(sandbox):
    calls.clear(), outputs.clear(), holders.clear()
    return subprocess.run(
        ['/usr/bin/python3', '-c', "import sys; sys.path.insert(0, '/opt/merv/python'); "
         'from merv_sandboxes.runtimes import assignment; sys.exit(assignment.main())',
         '--', '/opt/merv/bin/codex', 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral',
         '--skip-git-repo-check', '--sandbox', sandbox, '--json', '-C', str(work),
         *[part for setting in settings for part in ('-c', setting)], '--model', 'gpt-6-luna', '-'],
        cwd=work, input=b'Run the probe, then stop.', capture_output=True, timeout=120,
        env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'MERV_AGENT_SESSION_TOKEN': session,
             'MERV_MCP_URL': f'{base}/mcp'},
    )


launch = codex('workspace-write')
# Codex's own sandbox needs unprivileged user namespaces, which some release hosts refuse (Ubuntu
# 24.04's AppArmor restriction). There the gate proves all but that sandbox, says so, and the
# sandbox is proved where it runs: a Fleet step on Cloudflare.
sandboxed = 'No permissions to create a new namespace' not in ''.join(outputs)
if not sandboxed:
    launch = codex('danger-full-access')
server.shutdown()
server.server_close()
thread.join(timeout=5)
probe = ''.join(outputs)
codex_home = [p for p in Path('/home/assignment/.codex').rglob('*') if p.is_file()]
assert launch.returncode == 0 and len(calls) >= 2, 'hosted Codex did not finish through the relay'
assert all(c[:2] == ('POST', '/codex-model/responses') and set(c[2]) <= KEYS and c[3] <= TOOLS
           for c in calls), calls
assert 'uid 12001 probe-done' in probe, probe
assert not sandboxed or ('readable ' not in probe and holders), probe
assert 'network-on' in probe, probe
assert not any(p.name == 'auth.json' or session.encode() in p.read_bytes() for p in codex_home)
for secret in [enrollment.encode(), model_key.encode(), session.encode()]:
    assert secret not in output + error + refused_output + launch.stdout + launch.stderr
print(json.dumps({
    'gate': 'linux-workflow-dispatch', 'fixedSupervisor': True, 'bootstrapWithModelKeyRefused': True,
    'managedEnrollmentReached': True, 'bootstrapRemoved': True, 'noCredentialInArgvOrEnvironment': True,
    'codexCalledOnlyTheRelay': True, 'codexRequestKeys': sorted({k for c in calls for k in c[2]}),
    'noCredentialFileInCodexHome': True, 'shellNetworkOn': True, 'codexSandboxOnHost': sandboxed,
    **({'sessionBearerUnreadableFromShell': True} if sandboxed else {}),
}))
