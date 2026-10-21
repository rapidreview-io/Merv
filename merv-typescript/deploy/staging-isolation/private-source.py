#!/usr/bin/env python3
"""Run on production as root. Export only reviewed provider/public identity fields.
Never transports the source DB URL, vault, gateway keys, customer providers or balances.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
spec=importlib.util.spec_from_file_location('vm',Path(__file__).parents[1]/'hosted-release-vm.py')
vm=importlib.util.module_from_spec(spec);spec.loader.exec_module(vm)
if __name__=='__main__':
 os.umask(0o077)
 vm.need(os.geteuid()==0,'root required')
 source=vm.file_env(vm.SHARED.read_bytes())
 keys=('FLEET_CLOUDFLARE_BRIDGE_STAGING','FLEET_CLOUDFLARE_BRIDGE_STAGING_LARGE','SANDBOXES_SUPABASE','SANDBOXES_STORAGE__BUCKET')
 selected={k:source[k] for k in keys}
 providers=[p for p in json.loads(source['SANDBOXES_PROVIDERS']) if p['name'] in vm.STAGING_APPS]
 vm.need(len(providers)==2 and all(p['settings']['application_id']==vm.STAGING_APPS[p['name']] for p in providers),'provider identity changed')
 selected['SANDBOXES_PROVIDERS']=json.dumps(providers,separators=(',',':'))
 destination=Path(sys.argv[1]);destination.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
 vm.need(destination.parent.stat().st_mode & 0o077==0,'private destination required')
 vm.atomic(destination,(''.join(k+'='+v+'\n' for k,v in selected.items())).encode())
 print(json.dumps({'exportedFields':sorted(selected),'providers':sorted(vm.STAGING_APPS)}))
