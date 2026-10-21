"""Actual helper calls with a Docker state adapter at Compose stop/remove/rename/start.
No real Docker daemon crash or provider call is claimed. Canonical names may disappear.
"""
import copy,importlib.util,json,tempfile,unittest,shutil,io
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('gap_handoff',Path(__file__).with_name('handoff.py'));h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h);v=h.vm
class ReaderGap(unittest.TestCase):
 def test_each_reader_lifecycle_boundary_and_independent_admission_restore(self):
  for victim in (v.MAIN,v.CONTROL):
   for boundary in ('stop','remove','rename','start'):
    with self.subTest(reader=victim,boundary=boundary),tempfile.TemporaryDirectory() as tmp:
     root=Path(tmp);home=root/'home';home.mkdir();shared=root/'shared.env';main=root/'main.env'
     raw=b'MERV_BOOT_MAINTENANCE=1\nSANDBOXES_PROVIDERS=[]\nSANDBOXES_RUNTIME_RELEASES=[]\nSANDBOXES_DATABASE_URL=postgresql://private/source\nMERV_DB_URL=postgresql://private/main\n'
     target=raw+b'TARGET=forward\n';shared.write_bytes(raw);main.write_bytes(raw)
     states={name:{'Image':'sha256:'+('1' if name==v.MAIN else '2')*64,'State':{'Running':True},'NetworkSettings':{'Networks':{'preserved-network':{}}},'Config':{'Env':raw.decode().splitlines(),'Labels':{'com.docker.compose.project':name,'com.docker.compose.project.config_files':'compose.yml','com.docker.compose.project.working_dir':str(root),'com.docker.compose.service':'control'}}} for name in (v.MAIN,v.CONTROL)}
     originals=copy.deepcopy(states);armed=[True];calls=[]
     database={'database':'production'}
     plan={'version':1,'apps':v.STAGING_APPS,'source':{'database':database,'images':{n:s['Image'] for n,s in states.items()}},'destination':{'database':{'database':'sandboxes_staging'},'images':{}},'historySha256':'a'*64,'restoreRehearsal':'b'*64,'relay':{'boundary':0},'publicOrigin':'https://staging.example'}
     def inspect(name):
      if name not in states:raise RuntimeError('No such object: '+name)
      return copy.deepcopy(states[name])
     def effect(cmd,**kw):
      calls.append((cmd,kw))
      if 'up' in cmd:
       name=cmd[cmd.index('-p')+1];key='MERV_TS_IMAGE' if name==v.MAIN else 'SANDBOXES_TS_IMAGE'
       self.assertEqual(kw['env'][key],originals[name]['Image'])
       temporary=copy.deepcopy(originals[name]);temporary['Config']['Env']=shared.read_text().splitlines();temporary['State']['Running']=False
       for phase in ('stop','remove','rename','start'):
        if phase=='stop' and name in states:states[name]['State']['Running']=False
        elif phase=='remove':states.pop(name,None);states['temporary-'+name]=temporary
        elif phase=='rename':states[name]=states.pop('temporary-'+name)
        elif phase=='start':states[name]['State']['Running']=True
        if name==victim and phase==boundary and armed[0]:armed[0]=False;raise RuntimeError('interrupted at '+phase)
      if kw.get('env',{}).get('MERV_PI_HANDOFF')=='restore':
       self.assertEqual(kw['env']['MERV_DB_URL'],'postgresql://private/main');self.assertIn(originals[v.MAIN]['Image'],cmd);self.assertIn('preserved-network',cmd)
       return b'{"active":false,"commands":0,"hosts":0,"allocations":0}'
      if kw.get('env',{}).get('MERV_Q'):return json.dumps(database).encode()
      return b''
     def healthy(name,*args):self.assertTrue(inspect(name)['State']['Running'])
     with patch.multiple(v,HOME=home,SHARED=shared,ENV=main,MAINTENANCE=root/'maintenance',RECOVERY_PENDING=root/'absent'),patch.object(h,'ROOT',root),patch.object(v,'inspect',side_effect=inspect),patch.object(v,'run',side_effect=effect),patch.object(v,'healthy',side_effect=healthy),patch.object(v,'main_release_running',return_value=False):
      h.execute('reserve','source',plan)
      with self.assertRaisesRegex(RuntimeError,'interrupted'):v.Step(root,{}).sandboxes_file(network_none=True)[1](target)
      if boundary=='remove':self.assertNotIn(victim,states)
      # Both SQL identity and documented explicit admission restoration work in the gap.
      with v.reader_recovery(root):h.stable_identity(plan['source'])
      self.assertFalse(h.execute('restore-admission','source',plan)['active'])
      # Exercise the actual pre-drain gateway repair then the actual first driver Step.drain.
      run_name='20261021T160000Z-12345678-staging';runs=root/'runs';run_dir=runs/run_name;catalog=run_dir/'local-catalog';catalog.mkdir(parents=True)
      binding={'isolated':'exact'};source={'entries':[],'releases':{}}
      run_plan={'cutover':True,'stagingCutover':True,'isolatedStaging':True,'isolation':binding,'stagingSource':source}
      v.atomic(run_dir/'plan.json',json.dumps(run_plan).encode());v.atomic(home/'active',run_name.encode())
      for filename in ('reader-originals.json','reader-target.json'):shutil.copy2(root/filename,catalog/filename)
      v.atomic(catalog/'original.env',raw);v.atomic(catalog/'target.env',target)
      v.atomic(catalog/'intent.json',json.dumps({'source':source,'isolation':binding,'before':v.sha(raw),'target':v.sha(target)}).encode())
      args={'action':'recover-catalog','run':run_name,'source':source}
      with patch.object(v,'RUNS',runs),patch.object(v,'isolation_identity',return_value=binding),patch.object(v,'isolated_census',return_value={'drained':True}),patch.object(v,'reader_read',return_value={'n':0}):
       main.write_bytes(b'MERV_BOOT_MAINTENANCE=0\n')
       with self.assertRaisesRegex(RuntimeError,'boot maintenance'):v.isolated_staging_gateway(args)
       main.write_bytes(raw)
       with patch.object(v,'reader_read',return_value={'n':1}):
        with self.assertRaisesRegex(RuntimeError,'ownership is not empty'):v.isolated_staging_gateway(args)
       self.assertTrue(v.isolated_staging_gateway(args)['recovered'])
       with patch.object(v.urllib.request,'urlopen',return_value=io.BytesIO(b'{"status":"ok","maintenance":true}')),patch.object(v,'main_read',side_effect=lambda *a,**kw:({'n':0} if inspect(v.MAIN)['State']['Running'] else (_ for _ in ()).throw(RuntimeError('Main absent')))):
        self.assertTrue(v.Step(run_dir,run_plan).drain({})['drained'])
      v.Step(root,{}).sandboxes_file(network_none=True)[1](target)
      for name in originals:self.assertEqual(v.env_of(name)['TARGET'],'forward');self.assertTrue(states[name]['State']['Running'])
      with self.assertRaisesRegex(RuntimeError,'target changed'):v.Step(root,{}).sandboxes_file(network_none=True)[1](raw)
      states[victim]['Image']='sha256:'+'f'*64
      with self.assertRaisesRegex(RuntimeError,'image or Compose identity'):v.Step(root,{}).sandboxes_file(network_none=True)
      states[victim]['Image']=originals[victim]['Image'];states[victim]['Config']['Labels']['com.docker.compose.project']='unrelated'
      v.atomic(home/'active',h.NAME.encode())
      with self.assertRaisesRegex(RuntimeError,'image or Compose identity'):h.execute('restore-admission','source',plan)
if __name__=='__main__':unittest.main()
