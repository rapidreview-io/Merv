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
enrolled = threading.Event()


class Enrollment(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        size = int(self.headers.get('content-length', '0'))
        body = self.rfile.read(min(size, 4096))
        if (self.path == '/sessions/runners/enroll' and
                self.headers.get('authorization') == 'Bearer ' + enrollment and
                self.headers.get('x-merv-project-id') == 'project_workflow_gate' and
                isinstance(json.loads(body).get('workerNonce'), str) and
                len(json.loads(body)['workerNonce']) == 64):
            enrolled.set()
        self.send_response(503)
        self.end_headers()

    def log_message(self, *_args):
        pass


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Enrollment)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
filename = Path('/run/merv-runtime/bootstrap-workflow-gate')
filename.write_text(json.dumps({
    'baseUrl': f'http://127.0.0.1:{server.server_port}',
    'projectId': 'project_workflow_gate',
    'enrollmentToken': enrollment,
    'modelApiKey': model_key,
}))
filename.chmod(0o600)
parent = subprocess.Popen(
    ['/opt/merv/runtime/start-runner'],
    env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'MERV_BOOTSTRAP_FILE': str(filename)},
    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    start_new_session=True,
)
try:
    assert enrolled.wait(30), 'fixed workflow supervisor did not reach managed enrollment'
    assert parent.poll() is None
    assert not filename.exists()
    command = Path(f'/proc/{parent.pid}/cmdline').read_bytes()
    assert command.split(b'\x00')[:2] == [b'/usr/local/bin/node', b'/opt/merv/runner/smoke-supervisor.mjs']
    environment = Path(f'/proc/{parent.pid}/environ').read_bytes()
    for secret in [enrollment.encode(), model_key.encode()]:
        assert secret not in command + environment
    print(json.dumps({
        'gate': 'linux-workflow-dispatch', 'fixedSupervisor': True,
        'codexLoginCompleted': True, 'managedEnrollmentReached': True,
        'bootstrapRemoved': True, 'noCredentialInArgvOrEnvironment': True,
    }))
finally:
    if parent.poll() is None:
        os.killpg(parent.pid, signal.SIGTERM)
    try:
        output, error = parent.communicate(timeout=8)
    except subprocess.TimeoutExpired:
        os.killpg(parent.pid, signal.SIGKILL)
        parent.communicate()
        raise RuntimeError('workflow supervisor failed to stop')
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
    filename.unlink(missing_ok=True)
    assert enrollment.encode() not in output + error
    assert model_key.encode() not in output + error
