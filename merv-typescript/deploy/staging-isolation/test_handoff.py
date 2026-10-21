import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('handoff',Path(__file__).with_name('handoff.py'))
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
vm=h.vm

class Crash(Exception): pass
class Handoff(unittest.TestCase):
 def setup_case(self, directory, role):
  root=Path(directory);h.ROOT=root/'isolation';vm.HOME=root/'hosted';vm.HOME.mkdir();vm.ENV=root/'main.env';vm.SHARED=root/'shared.env';vm.MAINTENANCE=root/'maintenance';vm.RECOVERY_PENDING=root/'recovery'
  self.providers=[{'name':p,'settings':{'application_id':app},'namespaces':['merv-stg-pi-da7c4bfa4d89860eee24'],'enabled':role=='source'} for p,app in h.APPS.items()]
  self.customer={'name':'customer','settings':{'application_id':'customer-app'}}
  self.catalog=[{'provider':p,'id':p} for p in [*h.APPS,'customer']]
  self.raw=('UNRELATED=preserve bytes\nSANDBOXES_PROVIDERS='+json.dumps(self.providers+([self.customer] if role=='source' else []))+'\nSANDBOXES_RUNTIME_RELEASES='+json.dumps(self.catalog)+'\n').encode()
  vm.SHARED.write_bytes(self.raw);vm.ENV.write_bytes(b'MERV_BOOT_MAINTENANCE=1\n')
  self.plan={'version':1,'apps':h.APPS,'source':{'database':{'database':'production'},'images':{}},'destination':{'database':{'database':'sandboxes_staging'},'images':{}},'historySha256':'a'*64,'restoreRehearsal':'b'*64,'relay':{'boundary':0},'publicOrigin':'https://staging.example:8443'}
  self.calls=[]
  self.env=lambda service:{**vm.file_env(vm.SHARED.read_bytes()),'MERV_BOOT_MAINTENANCE':'1'}
  self.apply=lambda raw: (self.calls.append(raw),vm.atomic(vm.SHARED,raw))
  self.patchers=[patch.object(vm,'main_release_running',return_value=False),patch.object(vm,'env_of',side_effect=self.env),patch.object(h,'stable_identity'),patch.object(h,'source_fence',return_value={'denied':True}),patch.object(vm,'quiet'),patch.object(h,'pi_admission',side_effect=lambda action:{'active':action=='apply' or (action=='inspect' and (h.ROOT/'pi-admission.intent.json').exists()),'commands':0,'hosts':0,'allocations':0}),patch.object(vm,'isolated_census',return_value={'drained':True}),patch.object(vm.Step,'sandboxes_file',return_value=(vm.SHARED,self.apply))]
  for p in self.patchers:p.start()
 def tearDown(self):
  for p in getattr(self,'patchers',[]):p.stop()
 def test_every_source_durable_boundary_resumes_forward(self):
  # Crash after each completed durable write, including between target and intent.
  for boundary in range(1,24):
   with self.subTest(boundary=boundary), tempfile.TemporaryDirectory() as d:
    self.setup_case(d,'source')
    original=vm.atomic;count=[0]
    def fail(path,raw,*args):
     original(path,raw,*args);count[0]+=1
     if count[0]==boundary:raise Crash()
    peer={'phase':'reserved','role':'destination','planHash':vm.sha(json.dumps(self.plan,sort_keys=True).encode())}
    with patch.object(vm,'atomic',side_effect=fail):
     try:
      h.execute('reserve','source',self.plan)
      h.execute('relinquish','source',self.plan,peer)
     except Crash:pass
    if not (h.ROOT/'reserved.json').exists():h.execute('reserve','source',self.plan)
    receipt=h.execute('relinquish','source',self.plan,peer)
    self.assertEqual(receipt['phase'],'source-relinquished')
    self.assertEqual(json.loads(vm.env_value(vm.SHARED.read_bytes(),'SANDBOXES_PROVIDERS')),[self.customer])
    self.assertIn(b'UNRELATED=preserve bytes\n',vm.SHARED.read_bytes())
    self.assertEqual((h.ROOT/'shared.original').read_bytes(),self.raw)
    self.tearDown();self.patchers=[]
 def test_destination_requires_source_receipt_and_refuses_double_controller(self):
  with tempfile.TemporaryDirectory() as d:
   self.setup_case(d,'destination')
   h.execute('reserve','destination',self.plan)
   with self.assertRaisesRegex(RuntimeError,'source relinquishment'):h.execute('enable','destination',self.plan,None)
   self.assertEqual(self.calls,[])
  self.tearDown();self.patchers=[]
  with tempfile.TemporaryDirectory() as d:
   self.setup_case(d,'source')
   with self.assertRaisesRegex(RuntimeError,'already enabled'):h.execute('reserve','destination',self.plan)
 def test_every_destination_write_resumes_after_durable_source_receipt(self):
  for boundary in range(1,5):
   with self.subTest(boundary=boundary),tempfile.TemporaryDirectory() as d:
    self.setup_case(d,'destination')
    target=self.raw.replace(b'"enabled": false',b'"enabled": true')
    self.plan['destination']['targetSha256']=vm.sha(target)
    h.execute('reserve','destination',self.plan)
    (h.ROOT/'destination.target').write_bytes(target)
    peer={'phase':'source-relinquished','role':'source','planHash':vm.sha(json.dumps(self.plan,sort_keys=True).encode()),'apps':h.APPS}
    original=vm.atomic;count=[0]
    def fail(path,raw,*args):
     original(path,raw,*args);count[0]+=1
     if count[0]==boundary:raise Crash()
    with patch.object(vm,'atomic',side_effect=fail):
     try:h.execute('enable','destination',self.plan,peer)
     except Crash:pass
    receipt=h.execute('enable','destination',self.plan,peer)
    self.assertEqual(receipt['phase'],'destination-enabled')
    self.assertTrue((h.ROOT/'source-receipt.json').is_file())
    self.assertEqual(h.execute('enable','destination',self.plan,peer),receipt)
    self.assertTrue(h.execute('release','destination',self.plan,receipt)['released'])
    self.assertTrue(h.execute('release','destination',self.plan,receipt)['released'])
    self.tearDown();self.patchers=[]
 def test_app_confusion_and_unknown_inventory_refused(self):
  with tempfile.TemporaryDirectory() as d:
   self.setup_case(d,'source');h.execute('reserve','source',self.plan)
   peer={'phase':'reserved','role':'destination','planHash':vm.sha(json.dumps(self.plan,sort_keys=True).encode())}
   with patch.object(vm,'isolated_census',side_effect=RuntimeError('unknown inventory')):
    with self.assertRaisesRegex(RuntimeError,'unknown inventory'):h.execute('relinquish','source',self.plan,peer)
   self.assertEqual(self.calls,[])
   bad=self.raw.replace(next(iter(h.APPS.values())).encode(),b'production-app')
   with self.assertRaisesRegex(RuntimeError,'app identity'):h.env_target(bad)

if __name__=='__main__':unittest.main()
