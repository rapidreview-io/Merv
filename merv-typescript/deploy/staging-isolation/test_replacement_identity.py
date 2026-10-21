import copy,importlib.util,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('replacement_vm',Path(__file__).parents[1]/'hosted-release-vm.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
class Replacement(unittest.TestCase):
 def test_only_exact_unique_target_replacement_is_renamed(self):
  for change in ('valid','image','project','service','environment','command','network','ambiguous'):
   with self.subTest(change=change),tempfile.TemporaryDirectory() as tmp:
    root=Path(tmp);raw=b'VALUE=target\n';image='sha256:'+'1'*64;identifier='a'*64
    original={'Image':image,'Config':{'Env':['VALUE=original'],'Cmd':['run'],'Labels':{'com.docker.compose.project':'owned','com.docker.compose.service':'control','com.docker.compose.container-number':'1','com.docker.compose.oneoff':'False'}},'NetworkSettings':{'Networks':{'owned-network':{}}}}
    replacement=copy.deepcopy(original);replacement['Config']['Env']=['VALUE=target'];replacement['Config']['Labels']['com.docker.compose.replace']='control-1'
    if change=='image':replacement['Image']='wrong'
    if change in ('project','service'):replacement['Config']['Labels']['com.docker.compose.'+change]='unrelated'
    if change=='environment':replacement['Config']['Env']=['VALUE=other']
    if change=='command':replacement['Config']['Cmd']=['other']
    if change=='network':replacement['NetworkSettings']['Networks']={'unrelated':{}}
    states={identifier:replacement,v.CONTROL:original};renames=[]
    def inspect(name):
     if name not in states:raise RuntimeError('No such object')
     return states[name]
    def run(command,**kw):
     if command[1]=='ps':return (identifier+(' b'*32 if change=='ambiguous' else '')).encode()
     if command[1]=='rename':renames.append(command);states[command[3]]=states[command[2]];return b''
     raise AssertionError(command)
    v.atomic(root/'reader-originals.json',json.dumps({v.MAIN:original,v.CONTROL:original}).encode())
    with patch.object(v,'inspect',side_effect=inspect),patch.object(v,'run',side_effect=run),v.reader_recovery(root):
     if change=='valid':
      v.recover_reader_name(v.MAIN,raw,root);v.recover_reader_name(v.MAIN,raw,root)
      self.assertEqual(len(renames),1);self.assertTrue((root/'reader-rename-main.json').exists())
     else:
      with self.assertRaises(RuntimeError):v.recover_reader_name(v.MAIN,raw,root)
      self.assertEqual(renames,[])
if __name__=='__main__':unittest.main()
