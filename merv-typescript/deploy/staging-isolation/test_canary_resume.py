import importlib.util,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('canary_vm',Path(__file__).parents[1]/'hosted-release-vm.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
class Canary(unittest.TestCase):
 def test_lost_response_resume_terminal_failure_and_success_replay(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp);commands={};calls=[];fail=[True];failed_attempt=[False]
   step=v.Step(p,{'isolatedStaging':True,'stagingCutover':True,'cutover':True,'canary':{'credential':'/unused'},'current':{'image':'image'}})
   def tool(c,name,body,**kw):
    calls.append(name)
    if name=='pi.create':return {'id':body['requestId']}
    if name=='pi.send':
     key=body['commandId']
     commands.setdefault(key,{'id':key,'status':'working','runtimeId':'allocation-'+key,'messages':[]})
     return commands[key]
    if name=='pi.snapshot':
     if fail[0]:fail[0]=False;raise RuntimeError('lost response')
     key='canary-'+body['id'].removeprefix('hosted-');command=commands[key]
     if failed_attempt[0]:command.update(status='interrupted',error='provider_failure');failed_attempt[0]=False
     elif command['status']=='working':command.update(status='completed',messages=[{'role':'assistant','text':key}])
     return {'commands':[command]}
    raise AssertionError('must never cancel live/shared work: '+name)
   with patch.object(v,'credential',return_value={}),patch.object(v,'whoami'),patch.object(v,'tool',side_effect=tool),patch.object(v,'isolation_identity',return_value={'binding':'exact'}),patch.object(v.Step,'staging_accept'),patch.object(v.Step,'staging_census'),patch.object(v,'isolated_census'),patch.object(v,'run',return_value=b'{"profile":"release"}'),patch.object(v,'main_read',return_value={'n':1}):
    with self.assertRaisesRegex(RuntimeError,'lost response'):step.canary({'releaseId':'release'})
    first=v.read(p/'isolated-canary.intent.json');self.assertEqual(len(commands),1)
    self.assertEqual(next(iter(commands.values()))['status'],'working')
    failed_attempt[0]=True
    with self.assertRaisesRegex(RuntimeError,'canary_failed'):step.canary({'releaseId':'release'})
    self.assertEqual(v.read(p/'isolated-canary.intent.json'),first)
    result=step.canary({'releaseId':'release'});self.assertEqual(result['status'],'completed');self.assertEqual(len(commands),2)
    second=v.read(p/'isolated-canary.intent.json');self.assertEqual(second['generation'],2)
    self.assertEqual(step.canary({'releaseId':'release'})['status'],'completed');self.assertEqual(len(commands),2)
    self.assertTrue((p/('isolated-canary.attempt-'+first['nonce']+'.json')).exists())
if __name__=='__main__':unittest.main()
