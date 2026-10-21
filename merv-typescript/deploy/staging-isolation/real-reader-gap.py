"""Opt-in local Docker/Compose regression. No production names, ports or provider access.
Requires an already-local python:3.12-slim image; does not pull. Only render/migrate
preflights are adapted. Compose, rename, start, health and cleanup use the real daemon.
"""
import importlib.util,json,os,subprocess,tempfile,uuid
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('real_gap_vm',Path(__file__).parents[1]/'hosted-release-vm.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
def cmd(*args,**kwargs):return subprocess.check_output(list(args),stderr=subprocess.STDOUT,**kwargs)
image=json.loads(cmd('docker','inspect','python:3.12-slim'))[0]['Id']
print(json.dumps({'compose':cmd('docker','compose','version','--short').decode().strip(),'image':image}),flush=True)
for role in ('source','destination'):
 for victim_role in ('main','control'):
  with tempfile.TemporaryDirectory(prefix='merv-reader-gap-') as temp:
   root=Path(temp);prefix='merv-gap-'+uuid.uuid4().hex[:10];network=prefix+'-network'
   projects={prefix+'-main':'MERV_TS_IMAGE',prefix+'-control':'SANDBOXES_TS_IMAGE'}
   v.MAIN=prefix+'-main-control-1';v.CONTROL=prefix+'-control-control-1';v.SHARED=root/'shared.env'
   raw=b'SANDBOXES_PROVIDERS=[]\nSANDBOXES_RUNTIME_RELEASES=[]\nMERV_BOOT_MAINTENANCE=1\n';target=raw+b'GAP_TEST=forward\n';v.SHARED.write_bytes(raw)
   (root/'release.env').write_text('');created=[];temporary='';original_run=v.run
   try:
    cmd('docker','network','create',network)
    for project,key in projects.items():
     folder=root/project;folder.mkdir();(folder/'compose.yml').write_text('services:\n  control:\n    image: ${'+key+'}\n    entrypoint: ["python", "-c", "import time;time.sleep(9999)"]\n    env_file: ["'+str(v.SHARED)+'"]\n    stop_grace_period: 1s\n    healthcheck:\n      test: ["CMD", "python", "-c", "pass"]\n      interval: 1s\n      timeout: 1s\n      retries: 5\n    networks: [gap]\nnetworks:\n  gap:\n    external: true\n    name: '+network+'\n')
     cmd('docker','compose','-p',project,'-f',str(folder/'compose.yml'),'up','-d',env={**os.environ,key:image});created.append(project)
    victim=v.MAIN if victim_role=='main' else v.CONTROL;armed=[True]
    def effect(command,**kwargs):
     global temporary
     command=[str(root/'release.env') if x=='/etc/sandboxes/release.env' else x for x in command]
     if 'up' not in command and (('compose' in command and 'run' in command) or command[:2]==['docker','run']):return b''
     output=original_run(command,**kwargs)
     if 'up' in command and command[command.index('-p')+1]==prefix+'-'+victim_role and armed[0]:
      armed[0]=False;state=v.inspect(victim)
      print(json.dumps({'replacementLabels':state['Config']['Labels']}),flush=True)
      temporary=state['Id'][:12]+'_'+victim
      cmd('docker','stop','--time','1',victim);cmd('docker','rename',victim,temporary)
      raise RuntimeError('injected real canonical-name gap')
     return output
    with patch.object(v,'main_release_running',return_value=False),patch.object(v,'run',side_effect=effect):
     try:v.Step(root,{}).sandboxes_file(network_none=True)[1](target)
     except RuntimeError as e:assert str(e)=='injected real canonical-name gap'
     else:raise AssertionError('gap not injected')
     assert subprocess.run(['docker','inspect',victim],capture_output=True).returncode!=0
     v.Step(root,{}).sandboxes_file(network_none=True)[1](target)
     for name in (v.MAIN,v.CONTROL):
      assert v.inspect(name)['State']['Health']['Status']=='healthy'
      assert v.env_of(name)['GAP_TEST']=='forward'
     print(json.dumps({'role':role,'missingReader':victim_role,'recovered':True,'renameReceipt':v.read(root/('reader-rename-'+victim_role+'.json'))}),flush=True)
   finally:
    for project in created:
     subprocess.run(['docker','compose','-p',project,'-f',str(root/project/'compose.yml'),'down'],env={**os.environ,projects[project]:image},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if temporary:subprocess.run(['docker','rm','-f',temporary],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    subprocess.run(['docker','network','rm',network],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
