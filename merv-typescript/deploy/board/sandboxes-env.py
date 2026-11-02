#!/usr/bin/env python3
"""Renders /etc/merv-board/sandboxes.env from /etc/merv-board/sandboxes.secrets, made once here, as root:
sudo python3 sandboxes-env.py BRIDGE_URL APPLICATION_ID IMAGE_DIGEST EXECUTABLE_SHA256. The token that lets Sandboxes read
Cloudflare's own inventory is the file /etc/merv-board/cloudflare-api-token; with none, machines start and no worker launches."""
import hashlib, json, os, secrets, sys
ROOT, ORIGIN, HOST = '/etc/merv-board', 'https://merv-board.eastus2.cloudapp.azure.com:8443', 'merv-board.eastus2.cloudapp.azure.com'
ACCOUNT, PROVIDER, NAMESPACE = 'ac27350cd4a42855004ab960c906b6d5', 'cloudflare-fleet', 'merv-board-host'
url, app, digest, executable = sys.argv[1:]

path = f'{ROOT}/sandboxes.secrets'
if not os.path.exists(path):
    made = {k: secrets.token_urlsafe(32) for k in ('vault', 'bridge', 'db')}
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.write(fd, json.dumps(made).encode())
    os.close(fd)
known = json.load(open(path))
token = open(f'{ROOT}/cloudflare-api-token').read().strip() if os.path.exists(f'{ROOT}/cloudflare-api-token') else None
release = {'provider': PROVIDER, 'image_digest': digest, 'executable': '/opt/merv/runtime/start-runner',
           'executable_sha256': executable, 'arguments': [], 'enrollment_timeout_seconds': 60}
release_id = 'rt1_' + hashlib.sha256(json.dumps(['merv-runtime-release-v1', *[release[k] for k in (
    'provider', 'image_digest', 'executable', 'executable_sha256', 'arguments', 'enrollment_timeout_seconds')]],
    separators=(',', ':')).encode()).hexdigest()
env = {
    'SANDBOXES_DATABASE_URL': f"postgresql://sandboxes:{known['db']}@sandboxes-db:5432/sandboxes",
    'SANDBOXES_DATABASE_SCHEMA': 'public', 'SANDBOXES_DATA_DIR': '/data',
    'SANDBOXES_VAULT_KEY': known['vault'], 'SANDBOXES_PUBLIC_API_URL': ORIGIN, 'SANDBOXES_AUTH_PUBLIC_URL': ORIGIN,
    'SANDBOXES_AGENT_BINARY_URL': ORIGIN + '/agent', 'SANDBOXES_GATEWAY__PUBLIC_HOST': HOST,
    'SANDBOXES_GATEWAY__PUBLIC_PORT': '2222', 'SANDBOXES_ALLOW_SIGNUP': 'false', 'SANDBOXES_PIPELINES_ENABLED': 'false',
    'SANDBOXES_RUNTIME_RELEASES': json.dumps([release], separators=(',', ':')),
    'SANDBOXES_PROVIDERS': json.dumps([{
        'name': PROVIDER, 'plugin': 'cloudflare', 'credential': 'env:BOARD_CLOUDFLARE_BRIDGE', 'access': 'tunnel',
        'namespaces': [NAMESPACE],
        'settings': {'shapes': 'standard-1', 'account_id': ACCOUNT, 'application_id': app}}], separators=(',', ':')),
    'BOARD_CLOUDFLARE_BRIDGE': json.dumps({'bridge_url': url, 'bridge_token': known['bridge'],
                                           **({'cloudflare_api_token': token} if token else {})}, separators=(',', ':')),
}
fd = os.open(f'{ROOT}/sandboxes.env', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, ''.join(f'{k}={v}\n' for k, v in env.items()).encode())
os.close(fd)
print(release_id)
