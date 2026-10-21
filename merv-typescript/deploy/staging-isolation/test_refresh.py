import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('refresh',Path(__file__).with_name('refresh-readers.py'))
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
v=r.vm

class Refresh(unittest.TestCase):
 def test_exact_forward_images_without_manual_receipt_edits(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);v.ISOLATION=root/'accepted.json';v.HOME=root/'home';v.HOME.mkdir();v.MAINTENANCE=root/'maintenance';v.RECOVERY_PENDING=root/'recovery'
   before={'phase':'destination-enabled','database':{'database':'sandboxes_staging'},'apps':v.STAGING_APPS,'images':{v.MAIN:'sha256:'+'1'*64,v.CONTROL:'sha256:'+'2'*64}}
   desired={v.MAIN:'sha256:'+'3'*64,v.CONTROL:'sha256:'+'4'*64};actual=dict(before['images'])
   v.atomic(v.ISOLATION,json.dumps(before).encode())
   def identity(binding_override=None):
    target=binding_override or v.read(v.ISOLATION)
    v.need(actual==target['images'],'actual images differ');return target
   frozen={'pins':['release',{}],'providers':['staging'],'catalog':['accepted'],'publicOrigin':'https://staging.example'}
   with patch.object(v,'owner',return_value=''),patch.object(v,'main_release_running',return_value=False),patch.object(v,'env_of',return_value={'MERV_BOOT_MAINTENANCE':'1'}),patch.object(v,'isolation_identity',side_effect=identity),patch.object(v,'staging_provider_census'),patch.object(v,'main_read',return_value={'ledger':'pinned'}),patch.object(r,'frozen',return_value=frozen):
    request={'update':'forward-1','images':desired,'migrations_sha256':v.sha(b'pinned')}
    intent=r.refresh('prepare',**request);self.assertEqual(v.read(v.ISOLATION),before)
    with self.assertRaisesRegex(RuntimeError,'actual images'):r.refresh('accept',**request)
    actual.update(desired)
    accepted=r.refresh('accept',**request)
    self.assertEqual(accepted['database'],before['database']);self.assertEqual(accepted['apps'],before['apps'])
    self.assertEqual(accepted['images'],desired)
    self.assertEqual(r.refresh('accept',**request),accepted)
    self.assertEqual(v.read(v.ISOLATION),accepted)
    self.assertEqual(v.read(root/'reader-updates/forward-1/intent.json'),intent)
    with patch.object(r,'frozen',return_value={**frozen,'pins':['wrong',{}]}):
     with self.assertRaisesRegex(RuntimeError,'changed pins'):r.refresh('accept',**request)

 def test_later_ordinary_production_acceptance_preserves_native_baseline(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);v.RUNS=root/'runs';v.HOME=root/'home';v.HOME.mkdir();v.RUNS.mkdir()
   current={'image':'registry.cloudflare.com/account/runtime@sha256:'+'a'*64,'releaseId':'r','releases':{v.PROVIDER:'r'},'sourceCommit':'later','sandboxesCommit':'pinned'}
   v.atomic(v.HOME/'state.json',json.dumps({'current':current}).encode())
   for name,plan,image in [('baseline',{'cutover':True,'sourceCommit':'old','sandboxesCommit':'pinned'},'old-image'),('ordinary',{'sourceCommit':'later','sandboxesCommit':'pinned'},current['image'])]:
    path=v.RUNS/name;path.mkdir();v.atomic(path/'finish.json',b'{"result":"pass"}');v.atomic(path/'plan.json',json.dumps(plan).encode());v.atomic(path/'push.json',json.dumps({'image':image}).encode());v.atomic(path/'progress.json',b'{"cutoverPrepared":true}')
   live={'releases':current['releases'],'fileReleases':current['releases'],'mainReleaseId':'r','fileReleaseId':'r','apps':{v.PROVIDER:{'image':current['image'],'rollout':None}}}
   with patch.object(v,'owner',return_value=''),patch.object(v,'main_release_running',return_value=False),patch.object(v,'inspect',return_value={'Config':{'Labels':{'org.merv.native-git-protocol':'1'}}}),patch.object(v.Step,'pins',return_value=live),patch.object(v,'env_of',return_value={v.CATALOG:json.dumps([{'provider':v.PROVIDER,'image_digest':'sha256:'+'a'*64}])}),patch.object(v,'release_ids',return_value=['r']):
    self.assertEqual(v.staging_source()['acceptedRun'],'ordinary')
    # A real no-op record extends provenance only with its builder's equality proof.
    next_current={**current,'sourceCommit':'noop'}
    path=v.RUNS/'noop';path.mkdir()
    v.atomic(path/'plan.json',json.dumps({'sourceCommit':'noop','sandboxesCommit':'pinned','current':current}).encode())
    v.atomic(path/'finish.json',b'{"result":"current"}')
    v.atomic(path/'build.json',b'{"lane":"none","changedCount":0,"configChanged":false}')
    v.atomic(v.HOME/'state.json',json.dumps({'current':next_current}).encode())
    self.assertEqual(v.staging_source()['acceptedRun'],'noop')
    v.atomic(path/'build.json',b'{"lane":"none","changedCount":1,"configChanged":false}')
    with self.assertRaisesRegex(RuntimeError,'no completed acceptance'):v.staging_source()
    v.atomic(path/'build.json',b'{"lane":"none","changedCount":0,"configChanged":false}')
    v.atomic(v.RUNS/'ordinary/finish.json',b'{"result":"failed"}')
    with self.assertRaisesRegex(RuntimeError,'no completed acceptance'):v.staging_source()
    # Rechecked/abandoned outcomes need the exact new successful canary acceptance receipt.
    canary={'accepted':True,'image':next_current['image'],'releaseId':'r'}
    v.atomic(path/'canary.json',json.dumps(canary).encode())
    v.atomic(path/'acceptance.json',json.dumps({'current':next_current,'canary':canary}).encode())
    for outcome in ('rechecked','abandoned'):
     v.atomic(path/'finish.json',json.dumps({'result':outcome}).encode())
     self.assertEqual(v.staging_source()['acceptedRun'],'noop')
    v.atomic(path/'canary.json',json.dumps({**canary,'releaseId':'wrong'}).encode())
    with self.assertRaisesRegex(RuntimeError,'no completed acceptance'):v.staging_source()
if __name__=='__main__':unittest.main()
