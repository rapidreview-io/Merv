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
# Every workflow machine is a work host of one work item: an image whose supervisor refuses that
# bootstrap, or cannot reset between its steps below, fails here, before its release switches.
work_instance = 'gate_work_' + secrets.token_hex(8)
enrolled = threading.Event()
# Main answers the enrollment, so the supervisor builds its runner with the work-host config and
# runs one step of the work item end to end: lease, reset, retained workspace, attach, Codex
# through the assignment launcher, and the release. A runner or Code driver that refuses that
# config, or a step that never reaches Codex, fails here.
control_token = 'mr_' + secrets.token_hex(32)
step_id = 'session_gate_' + secrets.token_hex(8)
step_secret, control_calls, step_calls = [], [], []
step_relayed, step_released = threading.Event(), threading.Event()
# Then a person's question to the step's agent: an inquiry visit on the same work host, which
# resumes the conversation the step kept, read-only, and keeps nothing of its own. The step's
# runner declares and delivers its conversation here; the inquiry is offered once the gate has
# read the step's own launch and receipt.
inquiry_id = 'session_gate_inquiry_' + secrets.token_hex(8)
inquiry_secret, inquiry_calls = [], []
kept = {}
conversation_stored, inquiry_ready, inquiry_released = threading.Event(), threading.Event(), threading.Event()
LAUNCHER = Path('/opt/merv/runtime/assignment-probed.py')
LAUNCH_RECORD = Path('/run/merv-runtime/gate-launch.json')
REAL_LAUNCHER = Path('/run/merv-runtime/assignment-probed.real.py')
MAIN_PORT = Path('/run/merv-runtime/gate-main-port')
# The step runs the image's own probed launcher, attestation included: the runner's real
# supervisor -> guardian -> [subreaper ->] group ancestry, its socket, the identity drop's
# denials and the sshd check, all as on a Cloudflare work host. A local fake Main is one more
# loopback listener, which the probe refuses by design and live Main never is; only that one
# listener is hidden from it. The stand-in also records the runner's exact launch.
ATTESTED = '''#!/usr/bin/python3
import json, os, sys
sys.path.insert(0, '/opt/merv/python')
import isolation_probe
port = int(open(%r).read())
listeners = isolation_probe._listeners
isolation_probe._listeners = lambda: [entry for entry in listeners()
                                      if entry != '0100007F:%%04X 0' %% port]
if sys.argv[1:4] == ['--', '/opt/merv/bin/codex', 'exec']:
    with open(%r, 'a') as f:
        f.write(json.dumps({'argv': sys.argv[1:], 'cwd': os.getcwd()}) + '\\n')
# Run as itself: the attestation pins this launcher's own path as argv[0].
exec(compile(open(%r).read(), %r, 'exec'), {'__name__': '__main__', '__file__': %r})
''' % (str(MAIN_PORT), str(LAUNCH_RECORD), str(REAL_LAUNCHER), str(LAUNCHER), str(LAUNCHER))


def step_session(runner_id, status='offered', host_ref=None, inquiry=False):
    common = {'instanceId': work_instance, 'projectId': 'project_workflow_gate', 'actorId': 'actor_gate', 'revision': 0}
    now = time.time()
    stamp = lambda t: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(t))
    read_only = inquiry
    session = {'id': inquiry_id if inquiry else step_id, 'projectId': 'project_workflow_gate', 'actorId': 'actor_gate',
               'instanceId': work_instance, 'threadId': 'thr_gate', 'runnerId': runner_id, 'hostRef': host_ref,
               'expectedRevision': 0, 'status': status, 'closeReason': None if status == 'offered' else 'released',
               'outcome': None, 'expiresAt': stamp(now + (600 if inquiry else 3600)),
               'hardDeadline': stamp(now + (600 if inquiry else 3600)),
               'assignment': {**common, 'label': 'Inquiry: gate' if inquiry else 'Gate step',
                              'brief': 'What did you reply?' if inquiry else 'Reply done.',
                              'execution': {'readOnly': read_only}},
               'execution': {**common, 'policy': {'readOnly': read_only, 'tools': []}, 'references': {}},
               # The step keeps its conversation, which the inquiry resumes.
               'continuity': {'key': 'gate-thread'}}
    if inquiry:
        session['continuity']['resume'] = {'sessionId': step_id, **kept['facts']}
        session['inquiry'] = {'id': 'inquiry_gate', 'messageId': 'session_message_gate', 'askedBy': 'actor_owner'}
    return session
step_state, inquiry_state = {}, {}


def control_reply(handler, method, body):
    """Sessions as the work host's runner sees it, for one step."""
    path = handler.path
    control_calls.append((method, path, body))
    if path == '/sessions/runners/heartbeat':
        return {'runner': {'runnerId': body['runnerId'], 'desiredVersion': 0, 'desiredSettings': {'platforms': []}}}
    if path == '/code/commands/next':
        return {'command': None}
    if path == '/sessions/lease':
        if not step_state:
            step_secret.append(body['secret'])
            step_state.update(runner=body['runnerId'], status='offered', hostRef=None)
            return {'session': step_session(body['runnerId']), 'reason': 'leased'}
        if inquiry_ready.is_set() and not inquiry_state:
            inquiry_secret.append(body['secret'])
            inquiry_state.update(runner=body['runnerId'], status='offered', hostRef=None)
            return {'session': step_session(body['runnerId'], inquiry=True), 'reason': 'offered'}
        return {'session': None, 'reason': 'no_candidates'}
    parts = path.split('/')
    if len(parts) < 3:
        return None
    inquiry = parts[2] == inquiry_id and bool(inquiry_state)
    if not inquiry and (parts[2] != step_id or not step_state):
        return None
    state = inquiry_state if inquiry else step_state
    action = parts[3] if len(parts) > 3 else None
    if inquiry:
        inquiry_calls.append(action)
    if action == 'conversation' and not inquiry:
        # The step's conversation, declared then delivered through one PUT to this Main.
        facts = {k: body[k] for k in ('harness', 'conversationId', 'sha256', 'size')}
        kept.setdefault('facts', facts)
        stored = kept.get('bytes') is not None
        reply = {'sessionId': step_id, 'sha256': facts['sha256'], 'size': facts['size'],
                 'uploadedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ') if stored else None}
        if body.get('deliver') and not stored:
            reply['upload'] = {'url': base + '/gate-conversation', 'headers': {},
                               'expiresAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + 3600))}
        return {'conversation': reply}
    if action == 'resume' and inquiry:
        return {'download': {'url': base + '/gate-conversation',
                             'expiresAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + 3600))}}
    if action in ('transcript', 'conversation', 'huggingface-access', 'stream', 'resume'):
        return None
    if action == 'launch-connections':
        return {'connections': []}
    if action == 'attach':
        state['hostRef'] = body['hostRef']
    if action == 'release':
        state['status'] = 'released'
        (inquiry_released if inquiry else step_released).set()
    session = step_session(state['runner'], state['status'], state['hostRef'], inquiry)
    prompt = 'Answer the question in the assignment, read-only.' if inquiry else 'Reply done.'
    return {'session': session, **({'prompt': prompt} if action == 'attach' else {})}
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
# Exercise the official helper through an advertised shell tool, within Codex's sandbox.
# Python's subprocess avoids Codex's shell-text patch interception hiding a missing executable.
PATCH_PROBE = r"""import os,subprocess
from pathlib import Path
assert os.getuid()==12001
patch='*** Begin Patch\n*** Add File: gate-native-patch\n+first\n*** End Patch\n'
created=subprocess.run(['apply_patch'],input=patch,text=True,capture_output=True)
assert created.returncode==0 and Path('gate-native-patch').read_text()=='first\n'
patch='*** Begin Patch\n*** Update File: gate-native-patch\n@@\n-first\n+second\n*** End Patch\n'
updated=subprocess.run(['apply_patch'],input=patch,text=True,capture_output=True)
assert updated.returncode==0 and Path('gate-native-patch').read_text()=='second\n'
Path('gate-native-patch').unlink()
patch='*** Begin Patch\n*** Add File: /tmp/merv-gate-outside-patch\n+outside\n*** End Patch\n'
outside=subprocess.run(['apply_patch'],input=patch,text=True,capture_output=True)
print('native-patch-workspace-ok')
print('native-patch-outside-blocked' if outside.returncode!=0 and not Path('/tmp/merv-gate-outside-patch').exists() else 'native-patch-outside-allowed')
"""


def probe_command(port):
    return (PROBE % port) + ("; python3 -c \"import os,hashlib; "
          "assert hashlib.sha256(os.environ.get('HF_TOKEN','').encode()).hexdigest() == '" + hf_digest + "'; "
          "assert os.environ.get('HF_ENDPOINT') == '" + hf_endpoint + "'; assert 'MERV_AGENT_SESSION_TOKEN' not in os.environ; print('hf-token-inherited')\"") + '; python3 -c ' + shlex.quote(PATCH_PROBE) + probe_suffix
calls, outputs, holders, relay_credentials, inquiry_inputs = [], [], set(), [], []


def environ(pid):
    try:
        return Path(f'/proc/{pid}/environ').read_bytes()
    except OSError:
        return b''


class Main(http.server.BaseHTTPRequestHandler):
    """Main as the machine sees it: managed enrollment, and the relay's /codex-model route."""

    def reply(self, value):
        if value is None:
            self.send_response(404)
            self.end_headers()
            return
        raw = json.dumps(value).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def controlled(self):
        return (self.headers.get('authorization') == 'Bearer ' + control_token and
                self.headers.get('x-merv-project-id') == 'project_workflow_gate')

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length', '0'))) or b'{}')
        if self.path == '/sessions/runners/enroll':
            if (self.headers.get('authorization') == 'Bearer ' + enrollment and
                    self.headers.get('x-merv-project-id') == 'project_workflow_gate' and
                    isinstance(body.get('workerNonce'), str) and len(body['workerNonce']) == 64):
                enrolled.set()
                return self.reply({'controlToken': control_token})
            self.send_response(401)
            self.end_headers()
            return
        stepped = self.headers.get('authorization') in ['Bearer ' + s for s in step_secret + inquiry_secret]
        if self.path == '/mcp' and stepped:
            # Merv's MCP server, which the step's Codex requires: a handshake and no tools.
            if 'id' not in body:
                self.send_response(202)
                self.end_headers()
                return
            result = ({'protocolVersion': body['params']['protocolVersion'], 'capabilities': {'tools': {}},
                       'serverInfo': {'name': 'merv', 'version': 'gate'}} if body['method'] == 'initialize'
                      else {'tools': []} if body['method'] == 'tools/list' else {})
            return self.reply({'jsonrpc': '2.0', 'id': body['id'], 'result': result})
        if not self.path.startswith('/codex-model/'):
            if not self.controlled():
                self.send_response(401)
                self.end_headers()
                return
            return self.reply(control_reply(self, 'POST', body))
        # The step's Codex, with the bearer its runner leased it with: one closing answer.
        if stepped:
            step_calls.append((self.path, sorted(body)))
            if inquiry_secret and self.headers.get('authorization') == 'Bearer ' + inquiry_secret[0]:
                # What the inquiry's Codex sends: the step's own turns first, as it resumed them.
                inquiry_inputs.append(json.dumps(body.get('input', [])))
            step_relayed.set()
            events = [{'type': 'response.created', 'response': {'id': 'resp_step'}},
                      {'type': 'response.output_item.done', 'output_index': 0, 'item': {
                          'type': 'message', 'role': 'assistant', 'id': 'msg_step',
                          'content': [{'type': 'output_text', 'text': 'done'}]}},
                      {'type': 'response.completed', 'response': {'id': 'resp_step', 'usage': {
                          'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}}]
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.end_headers()
            self.wfile.write(''.join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode())
            return
        current_credential = self.headers.get('authorization') == 'Bearer ' + session
        relay_credentials.append(current_credential)
        if not current_credential:
            self.send_response(401)
            self.end_headers()
            return
        # Codex 0.160 sends gpt-6.1-sol's tools as Responses Lite's first input item, not `tools`.
        tools = body.get('tools', []) + [t for i in body.get('input', [])
                                          if i.get('type') == 'additional_tools' for t in i.get('tools', [])]
        calls.append((self.command, self.path, sorted(body), {t.get('type') for t in tools} |
                      {t.get('type') for n in tools for t in n.get('tools', [])}))
        # Never inject an unadvertised tool: that can execute despite being invisible to the model.
        # The model's catalog runs it in code mode only: the shell is a tool of the advertised
        # JavaScript `exec`, which its description declares.
        declared = tools + [t for n in tools for t in n.get('tools', [])]
        assert any(t.get('type') == 'custom' and t.get('name') == 'exec' and
                   'exec_command(' in t.get('description', '') for t in declared), declared
        answered = [''.join(part.get('text', '') for part in i['output']) if isinstance(i['output'], list)
                    else i['output'] for i in body.get('input', []) if i.get('type') == 'custom_tool_call_output']
        if answered:
            outputs.extend(answered)
            # The bearer is there to find: its own uid, outside Codex's sandbox, reads it.
            holders.update(subprocess.run(
                ['/usr/bin/grep', '-lsaFf', '-', *map(str, Path('/proc').glob('[0-9]*/environ'))],
                input=session.encode(), capture_output=True, user=12001, group=12001, extra_groups=[],
            ).stdout.split())
        item = ({'type': 'message', 'role': 'assistant', 'id': 'msg_gate',
                 'content': [{'type': 'output_text', 'text': 'done'}]} if answered else
                {'type': 'custom_tool_call', 'name': 'exec', 'call_id': 'probe', 'input':
                 'const r = await tools.exec_command(%s);\ntext(r.output);' % json.dumps(
                     {'cmd': probe_command(self.server.server_port), 'yield_time_ms': 30000})})
        events = [{'type': 'response.created', 'response': {'id': 'resp_gate'}},
                  {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
                  {'type': 'response.completed', 'response': {'id': 'resp_gate', 'usage': {
                      'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}}]
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()
        self.wfile.write(''.join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode())

    def do_PUT(self):
        # The store's signed PUT of the step's conversation, which the inquiry's resume reads.
        raw = self.rfile.read(int(self.headers.get('content-length', '0')))
        if self.path != '/gate-conversation' or 'facts' not in kept or \
                hashlib.sha256(raw).hexdigest() != kept['facts']['sha256']:
            self.send_response(400)
            self.end_headers()
            return
        kept['bytes'] = raw
        conversation_stored.set()
        self.send_response(200)
        self.end_headers()

    def do_DELETE(self):
        self.send_response(405)
        self.end_headers()

    def do_GET(self):
        if self.path == '/gate-conversation' and kept.get('bytes') is not None:
            self.send_response(200)
            self.send_header('content-length', str(len(kept['bytes'])))
            self.end_headers()
            self.wfile.write(kept['bytes'])
            return
        if self.path == '/mcp':
            self.send_response(405)  # no server-initiated stream
            self.end_headers()
            return
        if self.path.startswith('/sessions/') and self.controlled():
            return self.reply(control_reply(self, 'GET', None))
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
original_launcher = LAUNCHER.read_bytes()
REAL_LAUNCHER.write_bytes(original_launcher)
MAIN_PORT.write_text(str(server.server_port))
LAUNCHER.write_text(ATTESTED)
# The release catalog Sandboxes provisions on a machine, which the probe requires root-private.
CATALOG = Path('/opt/merv/runtime/releases.json')
catalog_made = not CATALOG.exists()
if catalog_made:
    CATALOG.write_text('synthetic-root-private-canary')
    CATALOG.chmod(0o600)
filename, parent = supervise({'workInstanceId': work_instance})
try:
    assert enrolled.wait(30), 'fixed workflow supervisor did not reach managed enrollment'
    assert parent.poll() is None
    assert not filename.exists()
    command = Path(f'/proc/{parent.pid}/cmdline').read_bytes()
    assert command.split(b'\x00')[:2] == [b'/usr/local/bin/node', b'/opt/merv/runner/smoke-supervisor.mjs']
    assert enrollment.encode() not in command + environ(parent.pid)
    assert control_token.encode() not in command + environ(parent.pid)
    assert step_released.wait(120), 'the work host ran no step through to its release: ' + json.dumps(
        [(m, p) for m, p, _ in control_calls][-12:])
    # The step kept its conversation and delivered it: what an inquiry visit resumes.
    assert conversation_stored.wait(120), 'the step delivered no conversation: ' + json.dumps(
        [(m, p) for m, p, _ in control_calls][-12:])
    assert step_relayed.is_set(), "the step's Codex never called the relay with its own session bearer"
    assert all(p == '/codex-model/responses' and set(k) <= KEYS for p, k in step_calls), step_calls
    presences = [b for m, p, b in control_calls if p == '/sessions/runners/heartbeat']
    # Exactly its enrolment: the Code driver took the work-host config, and the hosted profile.
    # `inquiry.1`: the image runs inquiry visits as such, which only it can say.
    assert presences and all(b['capabilities'] == ['code.v2', 'inquiry.1', 'workflow.workhost.1'] and
                             [x['name'] for x in b['platforms']] == ['hosted-codex'] for b in presences), presences
    [leased] = [b for m, p, b in control_calls if p == '/sessions/lease'][:1]
    assert leased['platform']['name'] == 'hosted-codex'
    retained = Path('/workspace/assignments') / hashlib.sha256(work_instance.encode()).hexdigest()
    launch = json.loads(LAUNCH_RECORD.read_text().splitlines()[0])
    # What the probed launcher's own attestation requires of the launch, met by the runner.
    assert launch['cwd'] == str(retained) and launch['argv'][:3] == ['--', '/opt/merv/bin/codex', 'exec']
    assert [launch['argv'][i + 1] for i, v in enumerate(launch['argv'][:-1]) if v == '-C'] == [str(retained)]
    attached = [b for m, p, b in control_calls if p == f'/sessions/{step_id}/attach']
    assert attached and attached[0]['hostRef'].startswith('launch_')
    # The probed launcher attested this very launch: its receipt names the work host's directory
    # and the supervisor's actual ancestry, the group's subreaper included where Python runs it.
    receipt = json.loads((Path('/run/merv-isolation') / f'{retained.name}.json').read_text())
    assert receipt['workspace'] == retained.name and receipt['launch_id'] == attached[0]['hostRef'], receipt
    assert set(receipt['roots']) == {'supervisor', 'guardian', 'subreaper', 'group'}, receipt['roots']
    assert receipt['listeners'] == [], receipt['listeners']
    # The inquiry: the same host's next visit, resuming the step's conversation read-only.
    inquiry_ready.set()
    assert inquiry_released.wait(180), 'the work host ran no inquiry through to its release: ' + json.dumps(
        [(m, p) for m, p, _ in control_calls][-12:])
    launches = [json.loads(line) for line in LAUNCH_RECORD.read_text().splitlines()]
    assert len(launches) == 2, launches
    asked = launches[1]
    # Through the same attested launcher, in the work's own directory, which its sandbox only reads.
    assert asked['cwd'] == str(retained) and asked['argv'][:3] == ['--', '/opt/merv/bin/codex', 'exec']
    assert [asked['argv'][i + 1] for i, v in enumerate(asked['argv'][:-1]) if v == '-C'] == [str(retained)]
    assert [asked['argv'][i + 1] for i, v in enumerate(asked['argv'][:-1]) if v == '--sandbox'] == ['read-only'], asked
    assert asked['argv'][-3:] == ['resume', kept['facts']['conversationId'], '-'], asked['argv'][-3:]
    inquiry_attached = [b for m, p, b in control_calls if p == f'/sessions/{inquiry_id}/attach']
    receipt = json.loads((Path('/run/merv-isolation') / f'{retained.name}.json').read_text())
    assert receipt['launch_id'] == inquiry_attached[0]['hostRef'], receipt
    # It resumed the step's turns, asked the relay with its own bearer, and kept nothing back.
    assert inquiry_inputs and 'Reply done.' in inquiry_inputs[0], inquiry_inputs[:1]
    assert 'resume' in inquiry_calls and 'conversation' not in inquiry_calls, inquiry_calls
finally:
    LAUNCHER.write_bytes(original_launcher)
    LAUNCH_RECORD.unlink(missing_ok=True)
    REAL_LAUNCHER.unlink(missing_ok=True)
    MAIN_PORT.unlink(missing_ok=True)
    if catalog_made:
        CATALOG.unlink(missing_ok=True)
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
            'features.multi_agent=false', 'agents.enabled=false', 'features.shell_snapshot=false', 'allow_login_shell=false',
            'shell_environment_policy.inherit="all"', 'shell_environment_policy.include_only=["PATH","HOME","USER","TMPDIR","LANG","HF_TOKEN","HF_ENDPOINT"]', 'shell_environment_policy.ignore_default_excludes=true',
            'shell_environment_policy.experimental_use_profile=false',
            'shell_environment_policy.set={"PATH"="/usr/bin:/bin","HOME"="/home/assignment",'
            '"USER"="assignment","TMPDIR"="/tmp","LANG"="C.UTF-8"}',
            'sandbox_workspace_write.writable_roots=[]',
            'sandbox_workspace_write.exclude_tmpdir_env_var=true',
            'sandbox_workspace_write.exclude_slash_tmp=true',
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
    assert 'native-patch-workspace-ok' in probe, probe
    assert not sandboxed or ('native-patch-outside-blocked' in probe and
                             not Path('/tmp/merv-gate-outside-patch').exists()), probe
    Path('/tmp/merv-gate-outside-patch').unlink(missing_ok=True)
    assert not sandboxed or ('readable ' not in probe and holders), probe
    assert 'network-on' in probe and 'hf-token-inherited' in probe, probe
    assert hf_token not in json.dumps(settings)
    assert not any(hf_token.encode() in p.read_bytes() for p in home_files)
    assert not any(p.name == 'auth.json' or session.encode() in p.read_bytes() for p in home_files)
    request_keys.update(k for c in calls for k in c[2])
    transcripts.append(launch.stdout + launch.stderr)
    return sandboxed, probe


def reset():
    # Exactly the supervisor's barrier between a work host's steps (smoke-supervisor.ts).
    result = subprocess.run(
        ['/opt/merv/runtime/assignment-probed.py', '--reset'], cwd='/', env={'PATH': '/usr/bin:/bin'},
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


# Positive control: the official helper permits this exact path for the assignment UID
# outside Codex. A denied tool-shell write below therefore proves the sandbox boundary.
outside_path = Path('/tmp/merv-gate-outside-patch')
assert not outside_path.exists()
control = subprocess.run(
    ['/usr/bin/apply_patch'],
    input=b'*** Begin Patch\n*** Add File: /tmp/merv-gate-outside-patch\n+control\n*** End Patch\n',
    capture_output=True, user=12001, group=12001, extra_groups=[], cwd=work,
    env={'PATH': '/usr/bin:/bin'}, timeout=10,
)
assert control.returncode == 0 and outside_path.read_text() == 'control\n'
outside_path.unlink()

request_keys, transcripts, sandbox_results = set(), [], []
secret_values = [enrollment, model_key, session, hf_token, control_token, *step_secret, *inquiry_secret]
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
    'managedEnrollmentReached': True, 'workHostBootstrapEnrolled': True, 'workHostStepRan': True, 'bootstrapRemoved': True, 'noCredentialInArgvOrEnvironment': True,
    'codexCalledOnlyTheRelay': True, 'codexRequestKeys': sorted(request_keys),
    'noCredentialFileInCodexHome': True, 'shellNetworkOn': True, 'hfTokenInheritedByShell': True, 'hfTokenAbsentFromArgsConfigAndLogs': True, 'codexSandboxOnHost': sandboxed,
    **({'sessionBearerUnreadableFromShell': True} if sandboxed else {}),
    'nativeShellAdvertised': True, 'nativePatchWorkspaceEdits': True,
    **({'nativePatchOutsideWorkspaceDenied': True} if sandboxed else {}),
    'normalLaneExercised': True, 'retainedCodexLaunches': 2, 'retainedSameAbsoluteCwd': True,
    'retainedResearchPreserved': True, 'privateStateCanariesCleared': True,
    'detachedAssignmentDescendantsCleared': True, 'freshSessionCredentials': True,
    'resetBySupervisorLauncher': True,
    'codexSandboxPerLaunch': sandbox_results,
    # The work-host step's launch passed the probed launcher's own attestation, with only the
    # local fake Main's listener hidden; the normal and retained Codex launches below the step
    # call the assignment launcher directly.
    'workHostStepAttested': True,
    # A person's question to the step's agent ran on the same host as an inquiry visit: attested,
    # read-only, resuming the conversation the step kept, and declaring none of its own.
    'inquiryAttested': True, 'inquiryReadOnlySandbox': True, 'inquiryResumedStepConversation': True,
    'inquiryConversationNotKept': True,
}))
