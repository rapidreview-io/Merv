"""Execute the embedded mint program and verify private credential replay without host writes."""
import importlib.util,json,subprocess,tempfile,unittest,stat
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('vm',Path(__file__).with_name('hosted-release-vm.py'))
vm=importlib.util.module_from_spec(spec);spec.loader.exec_module(vm)

class Mint(unittest.TestCase):
    def test_actual_scope_exposes_credentials_service(self):
        result=subprocess.run(['node','--import','tsx','--input-type=module','-e',
            "import assert from 'node:assert/strict'; import {ProjectScope} from '@merv/scope'; "
            "const scope=new ProjectScope({}); for(const key of ['issueActor','issueActorCredential','actorCredentials','revokeCredential']) {"
            "assert.equal(typeof scope.credentials[key],'function'); assert.equal(scope[key],undefined);}"],
            cwd=Path(__file__).resolve().parent.parent,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
    def execute(self,actors):
        # Match the installed old and new ProjectScope surface: credential operations are
        # available only on credentials. Assertions inspect callers, role and revocation.
        prefix='''import assert from 'node:assert/strict';
const actors=ACTORS, calls=[];
const issued={actor:{id:'reader'},credential:{id:'new'},token:'fixture-only'};
const fixtureState={transaction:async fn=>fn({all:async()=>actors}),close:async()=>calls.push(['close'])};
const PostgresState={open:async()=>fixtureState};
const deploymentSchema=()=> 'merv_ts_staging';
class ProjectScope {
  async initialize() {}
  credentials={
    issueActor:async(c,i)=>{assert.deepEqual(c,{projectId:'project',actorId:'operator'});assert.deepEqual(i,{name:'pilot',role:'reader',expiresAt:null});calls.push(['issue']);return issued},
    issueActorCredential:async(c,i)=>{assert.deepEqual(c,{projectId:'project',actorId:'operator'});assert.deepEqual(i,{actorId:'reader',expiresAt:null});calls.push(['reissue']);return issued},
    actorCredentials:async(c,id)=>{assert.equal(c.actorId,'operator');assert.equal(id,'reader');return [{id:'new'},{id:'stale'},{id:'revoked',revokedAt:'earlier'}]},
    revokeCredential:async(c,id)=>{assert.equal(c.actorId,'operator');calls.push(['revoke',id])}
  };
}
process.env.MERV_CANARY_PROJECT='project';process.env.MERV_CANARY_NAME='pilot';
'''.replace('ACTORS',json.dumps(actors))
        body='\n'.join(line for line in vm.MINT.splitlines() if not line.startswith('import '))
        body=body.replace('process.stdout.write(JSON.stringify(', 'calls.push(JSON.parse(JSON.stringify(').replace('token:issued.token}));','token:issued.token})));')
        result=subprocess.run(['node','--input-type=module','-e',prefix+body+'\nconsole.log(JSON.stringify(calls));'],capture_output=True,text=True)
        return result
    def test_fresh_reader(self):
        result=self.execute([dict(id='operator',role='operator',active=True)])
        self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(json.loads(result.stdout)[0],['issue'])
    def test_existing_reader_reissues_and_revokes_only_stale_live_tokens(self):
        result=self.execute([dict(id='operator',role='operator',active=True),dict(id='reader',name='pilot',role='reader',active=True)])
        self.assertEqual(result.returncode,0,result.stderr)
        calls=json.loads(result.stdout);self.assertEqual(calls[:2],[['reissue'],['revoke','stale']]);self.assertEqual(calls[-1],['close'])
    def test_no_active_operator_refuses(self):
        result=self.execute([dict(id='operator',role='operator',active=False)])
        self.assertNotEqual(result.returncode,0);self.assertIn('no active independent nonmember operator',result.stderr)
    def test_saved_credential_replay_checks_private_file_and_identity_without_mint(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'credential.json';cred=dict(projectId='project',actorId='reader',credentialId='saved',token='fixture-only');path.write_text(json.dumps(cred));path.chmod(0o600)
            step=vm.Step(Path(tmp),{'canary':{'projectId':'project','credential':str(path)}})
            original=Path.lstat
            def root_stat(p):
                value=original(p)
                return SimpleNamespace(st_mode=value.st_mode,st_uid=0)
            with patch.object(Path,'lstat',root_stat),patch.object(vm,'run') as run,patch.object(vm,'whoami') as who:
                self.assertEqual(step.mint_canary({}),dict(existing=True,actorId='reader',credentialId='saved'));who.assert_called_once_with(cred);run.assert_not_called()
                path.chmod(0o644)
                with self.assertRaisesRegex(RuntimeError,'root-owned'):step.mint_canary({})
                path.chmod(0o600);step.plan['canary']['projectId']='other'
                with self.assertRaisesRegex(RuntimeError,'another project'):step.mint_canary({})
                run.assert_not_called()
if __name__=='__main__':unittest.main()
