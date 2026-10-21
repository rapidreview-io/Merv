import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('vm',Path(__file__).parents[1]/'hosted-release-vm.py')
v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)

class Catalog(unittest.TestCase):
 def test_real_two_entry_catalog_helper_interrupted_apply_and_idempotent_resume(self):
  for present in (False,True):
   with self.subTest(present=present),tempfile.TemporaryDirectory() as d:
    root=Path(d);run='20261021T160000Z-12345678-staging';home=root/'home';home.mkdir();runs=root/'runs';(runs/run).mkdir(parents=True)
    binding={'database':{'database':'sandboxes_staging'}}
    entries=[{'provider':p,'image_digest':'sha256:'+'a'*64} for p in v.STAGING_PROVIDERS]
    source={'entries':entries,'releases':{p:'rt1_'+p for p in v.STAGING_PROVIDERS}}
    (runs/run/'plan.json').write_text(json.dumps({'isolatedStaging':True,'isolation':binding,'stagingSource':source}))
    shared=root/'shared.env';original=('UNRELATED=keep\n'+v.CATALOG+'='+json.dumps(entries if present else [])+'\n').encode();shared.write_bytes(original)
    applied=[]
    def apply(raw):
     # Real durable env effect, interrupted before completion receipt / second reader confirmation.
     v.atomic(shared,raw);applied.append(raw)
     if len(applied)==1:raise RuntimeError('reader recreation interrupted')
    with patch.multiple(v,HOME=home,RUNS=runs,MAINTENANCE=root/'maintenance',RECOVERY_PENDING=root/'absent',SHARED=shared),patch.object(v,'main_release_running',return_value=False),patch.object(v,'owner',return_value=run),patch.object(v,'isolation_identity',return_value=binding),patch.object(v,'isolated_census',return_value={'drained':True}),patch.object(v.Step,'sandboxes_file',return_value=(shared,apply)):
     args={'action':'catalog','run':run,'source':source}
     self.assertEqual(v.isolated_staging_gateway({**args,'action':'recover-catalog'}),{'recovered':False})
     self.assertFalse((runs/run/'local-catalog').exists())
     with self.assertRaisesRegex(RuntimeError,'interrupted'):v.isolated_staging_gateway(args)
     journal=v.read(runs/run/'local-catalog/intent.json');self.assertEqual(journal['source'],source)
     self.assertEqual((runs/run/'local-catalog/original.env').read_bytes(),original)
     for _ in range(2):self.assertEqual(v.isolated_staging_gateway(args)['entries'],entries)
     self.assertEqual(len({x for x in applied}),1)
     self.assertEqual(json.loads(v.env_value(shared.read_bytes(),v.CATALOG)),entries)
     self.assertIn(b'UNRELATED=keep\n',shared.read_bytes())
     with self.assertRaisesRegex(RuntimeError,'source or isolation'):
      v.isolated_staging_gateway({**args,'source':{**source,'entries':[]}})
     with patch.object(v,'isolated_census',side_effect=RuntimeError('unknown local inventory')):
      before=len(applied)
      with self.assertRaisesRegex(RuntimeError,'unknown local inventory'):v.isolated_staging_gateway(args)
      self.assertEqual(len(applied),before)

 def test_isolated_queries_use_read_only_ephemeral_images_without_production_fallback(self):
  calls=[]
  def run(command,**kw):calls.append((command,kw));return b'{"database":"sandboxes_staging"}'
  with patch.object(v,'env_of',return_value={'SANDBOXES_DATABASE_URL':'postgresql://private/dedicated'}),patch.object(v,'inspect',return_value={'Image':'sha256:'+'a'*64}),patch.object(v,'run',side_effect=run):
   self.assertEqual(v.isolated_read('SELECT current_database()',url='SANDBOXES_DATABASE_URL')['database'],'sandboxes_staging')
   command,kw=calls[0];self.assertIn('sandboxes_default',command);self.assertNotIn('private',' '.join(command));self.assertNotIn('exec',command)
   self.assertIn("BEGIN READ ONLY",command[-1]);self.assertEqual(kw['env']['SANDBOXES_DATABASE_URL'],'postgresql://private/dedicated')
   with self.assertRaisesRegex(RuntimeError,'read-only'):v.isolated_read('DELETE FROM x',url='SANDBOXES_DATABASE_URL',write=True)
   with self.assertRaisesRegex(RuntimeError,'read-only'):v.isolated_read('SELECT 1',url='MERV_DB_URL')
   self.assertEqual(len(calls),1)
if __name__=='__main__':unittest.main()
