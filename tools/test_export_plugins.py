import copy
import json
import pathlib
import subprocess
import tempfile
import unittest

from export_plugins import ALLOWLIST, FILES, export, validate

ROOT = pathlib.Path(__file__).resolve().parents[1]

class ExportTests(unittest.TestCase):
    def setUp(self):
        self.files = {name: (ROOT / 'clients' / name).read_bytes() for name in FILES}
        self.files.update({name: (ROOT / name).read_bytes() for name in ('LICENSE', 'NOTICE')})

    def test_canonical_contract(self):
        self.assertEqual(validate(self.files), json.loads(self.files['manifest.json'])['version'])

    def test_bad_manifests_headers_versions_paths_and_parity_refused(self):
        changes = [
            ('codex/.mcp.json', {'mcpServers': {'merv': {'url':'http://example.test/mcp'}}}),
            ('claude-code/.mcp.json', {'mcpServers': {'merv': {'type':'http','url':'https://experiments.rapidreview.io/mcp','headers':{'Authorization':'secret'}}}}),
            ('codex/.codex-plugin/plugin.json', {'name':'merv','version':'0.0.0'}),
            ('.agents/plugins/marketplace.json', {'plugins':[{'name':'merv','source':{'source':'local','path':'../backend'}}]}),
        ]
        for name,value in changes:
            files={**self.files,name:json.dumps(value).encode()}
            with self.subTest(name=name), self.assertRaises(ValueError): validate(files)
        for name in ('codex/skills/research/SKILL.md','README.md'):
            files=copy.copy(self.files); del files[name]
            with self.assertRaises(ValueError): validate(files)
        with self.assertRaises(ValueError): validate({**self.files,'.env':b'secret'})
        with self.assertRaises(ValueError): validate({**self.files,'codex/skills/research/SKILL.md':b'drift'})
        with self.assertRaises(ValueError): validate(self.files,'0.0.0')

    def test_committed_export_exact_allowlist_and_no_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination=pathlib.Path(tmp)/'bundle'
            provenance=export(ROOT,'HEAD',destination)
            self.assertEqual({p.relative_to(destination).as_posix() for p in destination.rglob('*') if p.is_file()},ALLOWLIST)
            self.assertFalse((destination/'.git').exists())
            self.assertEqual(json.loads((destination/'manifest.json').read_bytes())['version'],provenance['pluginVersion'])
            self.assertEqual(len(provenance['sourceRevision']),40)
            with self.assertRaises(FileExistsError): export(ROOT,'HEAD',destination)

    def test_symlink_source_refused_and_uncommitted_files_excluded(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo=pathlib.Path(tmp)/'source'; repo.mkdir()
            def git(*args):
                return subprocess.check_output(['git','-C',str(repo),*args],stderr=subprocess.DEVNULL)
            git('init');git('config','user.email','test@example.test');git('config','user.name','Test')
            for name,data in self.files.items():
                path=repo/name if name in ('LICENSE','NOTICE') else repo/'clients'/name
                path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
            git('add','.');git('commit','-m','fixture')
            (repo/'clients/.env').write_text('do not publish')
            (repo/'clients/README.md').write_text('uncommitted replacement')
            out=pathlib.Path(tmp)/'export';export(repo,'HEAD',out)
            self.assertEqual((out/'README.md').read_bytes(),self.files['README.md'])
            (repo/'clients/README.md').unlink();(repo/'clients/README.md').symlink_to('../LICENSE')
            git('add','clients/README.md');git('commit','-m','symlink')
            with self.assertRaisesRegex(ValueError,'nonregular'):export(repo,'HEAD',pathlib.Path(tmp)/'bad')
            self.assertFalse((pathlib.Path(tmp)/'bad').exists())

if __name__ == '__main__': unittest.main()
