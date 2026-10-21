#!/usr/bin/env python3
"""Export only the committed, credential-free client plugin surface; no build/dependencies."""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess

SKILLS = ('research', 'operations', 'owners-agent', 'git-access')
CLIENTS = ('codex', 'claude-code')
FILES = ('manifest.json', 'README.md', '.agents/plugins/marketplace.json',
         '.claude-plugin/marketplace.json', 'codex/.codex-plugin/plugin.json',
         'claude-code/.claude-plugin/plugin.json', 'codex/.mcp.json', 'claude-code/.mcp.json') + tuple(
    f'{client}/skills/{skill}/SKILL.md' for client in CLIENTS for skill in SKILLS)
ALLOWLIST = frozenset((*FILES, 'LICENSE', 'NOTICE', 'PROVENANCE.json'))


def require(ok, message):
    if not ok:
        raise ValueError(message)


def validate(files, version=None):
    require(set(files) == ALLOWLIST - {'PROVENANCE.json'}, 'Unexpected or missing export files')
    load = lambda name: json.loads(files[name])
    manifest = load('manifest.json')
    current = manifest['version']
    require(re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', current), 'Invalid version')
    require(version is None or version == current, 'Requested version differs from manifest')
    require(manifest['skills'] == list(SKILLS), 'Canonical skill list differs')
    require(manifest['connect'] == 'https://experiments.rapidreview.io/connect/agent.md', 'Unexpected connect URL')
    codex = load('.agents/plugins/marketplace.json')['plugins']
    claude = load('.claude-plugin/marketplace.json')['plugins']
    require(len(codex) == len(claude) == 1, 'Expected one plugin per marketplace')
    require(codex[0]['name'] == claude[0]['name'] == 'merv', 'Marketplace plugin mismatch')
    require(codex[0]['source'] == {'source': 'local', 'path': './codex'}, 'Codex source must be local ./codex')
    require(claude[0]['source'] == './claude-code', 'Claude source must be local ./claude-code')
    require(claude[0]['version'] == current, 'Marketplace version mismatch')
    for client, metadata in [('codex', '.codex-plugin'), ('claude-code', '.claude-plugin')]:
        plugin = load(f'{client}/{metadata}/plugin.json')
        require(plugin['name'] == 'merv' and plugin['version'] == current, 'Plugin version/name mismatch')
        config = load(f'{client}/.mcp.json')
        expected = {'url': 'https://experiments.rapidreview.io/mcp'}
        if client == 'claude-code':
            expected['type'] = 'http'
        # Exact schema excludes headers, tokens, local commands, extra servers and env inputs.
        require(config == {'mcpServers': {'merv': expected}}, 'MCP must use HTTPS OAuth without headers/commands/env')
    require(load('codex/.codex-plugin/plugin.json')['skills'] == './skills/', 'Codex skills path mismatch')
    require(load('codex/.codex-plugin/plugin.json')['mcpServers'] == './.mcp.json', 'Codex MCP path mismatch')
    for skill in SKILLS:
        a, b = (files[f'{client}/skills/{skill}/SKILL.md'] for client in CLIENTS)
        require(a == b and a.strip(), 'Skill parity mismatch: ' + skill)
    require(files['README.md'].strip() and files['LICENSE'].strip() and files['NOTICE'].strip(), 'Missing user/license text')
    return current


def export(repo, revision, destination, version=None):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(repo), *args])
    commit = git('rev-parse', '--verify', revision + '^{commit}').decode().strip()
    files = {}
    for target in sorted(ALLOWLIST - {'PROVENANCE.json'}):
        source = target if target in ('LICENSE', 'NOTICE') else 'clients/' + target
        entry = git('ls-tree', commit, '--', source).decode().strip()
        require(entry.startswith('100644 blob ') or entry.startswith('100755 blob '), 'Missing/nonregular source: ' + source)
        files[target] = git('show', f'{commit}:{source}')
    current = validate(files, version)
    provenance = {'sourceRepository': 'rapidreview-io/Merv', 'sourceRevision': commit,
                  'pluginVersion': current, 'files': {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}}
    files['PROVENANCE.json'] = (json.dumps(provenance, indent=2) + '\n').encode()
    # Never merge into an existing checkout or follow an output symlink.
    destination.mkdir(parents=False, exist_ok=False)
    for name, data in files.items():
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(0o644)
    actual = {p.relative_to(destination).as_posix() for p in destination.rglob('*') if p.is_file()}
    require(actual == ALLOWLIST and not any(p.is_symlink() for p in destination.rglob('*')), 'Export allowlist mismatch')
    return provenance


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=pathlib.Path, required=True)
    parser.add_argument('--revision', default='HEAD')
    parser.add_argument('--version', help='Require this exact canonical version (for version tags)')
    args = parser.parse_args()
    repo = pathlib.Path(__file__).resolve().parents[1]
    print(json.dumps(export(repo, args.revision, args.out, args.version), indent=2))


if __name__ == '__main__':
    main()
