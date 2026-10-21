"""Local subprocess harness: the actual reader recreation function, durable file-backed
service effects in place of Docker, SIGKILL immediately after the selected external effect.
No providers or remote databases. Used by test_reader_crashes.py, never operator execution.
"""
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
spec=importlib.util.spec_from_file_location('vm',Path(__file__).parents[1]/'hosted-release-vm.py')
vm=importlib.util.module_from_spec(spec);spec.loader.exec_module(vm)
root=Path(sys.argv[1]);vm.SHARED=root/'shared.env';vm.ENV=root/'main.env'
vm.main_release_running=lambda:False
vm.healthy=lambda *args:None
vm.inspect=lambda name:{'Image':'sha256:'+('1' if name==vm.MAIN else '2')*64,'Config':{'Labels':{'com.docker.compose.project':name,'com.docker.compose.project.config_files':'compose.yml','com.docker.compose.project.working_dir':str(root)}}}
vm.env_of=lambda name:vm.file_env((root/(name+'.env')).read_bytes())
count=0

def effect(command,**kwargs):
 global count
 if 'up' in command:
  name=command[command.index('-p')+1]
  vm.atomic(root/(name+'.env'),vm.SHARED.read_bytes())
  count+=1
  # Snapshot actual persisted reader ability after each effect, before process death.
  observed={c:json.loads(vm.env_of(c)['SANDBOXES_PROVIDERS']) for c in (vm.MAIN,vm.CONTROL)}
  vm.atomic(root/('effect-'+str(count)+'.json'),json.dumps(observed).encode())
  if count==int(sys.argv[2]):os.kill(os.getpid(),signal.SIGKILL)
 return b''
vm.run=effect
vm.Step(root,{}).sandboxes_file(network_none=True)[1]((root/'target.env').read_bytes())
