#!/usr/bin/env python3
"""Explicit forward reader-binding update around the normal parent-owned image release.
prepare records old binding + desired exact images; accept verifies the actual new readers.
No image deployment, secret changes, ownership transfer or manual receipt editing occurs here.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
spec=importlib.util.spec_from_file_location('vm',Path(__file__).parents[1]/'hosted-release-vm.py')
vm=importlib.util.module_from_spec(spec);spec.loader.exec_module(vm)

def frozen():
 env=vm.env_of(vm.MAIN)
 return {'pins':vm.pins(env),'providers':json.loads(env['SANDBOXES_PROVIDERS']),
         'catalog':json.loads(env[vm.CATALOG]),'publicOrigin':env.get('MERV_SANDBOXES_PUBLIC_ORIGIN')}

def refresh(action,update,images,migrations_sha256):
 vm.need(re.fullmatch(r'[a-z0-9-]{1,80}',update) and set(images)=={vm.MAIN,vm.CONTROL} and all(re.fullmatch(r'sha256:[a-f0-9]{64}',v) for v in images.values()),'explicit exact reader update required')
 vm.need(re.fullmatch(r'[a-f0-9]{64}',migrations_sha256),'reviewed migration-ledger hash required')
 root=vm.ISOLATION.parent/'reader-updates'/update
 root.mkdir(mode=0o700,parents=True,exist_ok=True)
 with vm.MAINTENANCE.open('a') as maintenance,(vm.HOME/'lock').open('a') as lock:
  vm.need(vm.locked(maintenance,60) and vm.locked(lock,60),'deployment busy')
  vm.need(not vm.owner() and not vm.main_release_running() and not vm.RECOVERY_PENDING.exists(),'release/hosted/recovery owner active')
  vm.need(vm.env_of(vm.MAIN).get('MERV_BOOT_MAINTENANCE')=='1','reader update requires Main maintenance')
  request={'images':images,'migrationsSha256':migrations_sha256}
  old=vm.read(root/'intent.json')
  if action=='prepare':
   if old:
    vm.need(old['request']==request,'reader update target changed');return old
   before=vm.isolation_identity()
   vm.staging_provider_census()
   intent={'before':before,'request':request,'frozen':frozen()}
   vm.atomic(root/'intent.json',json.dumps(intent).encode());return intent
  vm.need(action=='accept' and old and old['request']==request,'prepared reader update missing')
  target={**old['before'],'images':images,'readerUpdate':update,'migrationsSha256':migrations_sha256}
  current=vm.read(vm.ISOLATION)
  vm.need(current in (old['before'],target),'another reader update changed binding')
  vm.need(frozen()==old['frozen'],'reader update changed pins, providers, catalog or origin')
  vm.need(vm.isolation_identity(binding_override=target)==target,'actual readers do not match target')
  ledger=vm.main_read("SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text AS ledger FROM public.sandboxes_migrations m",url='SANDBOXES_DATABASE_URL')
  vm.need(vm.sha(ledger['ledger'].encode())==migrations_sha256,'migration ledger differs from reviewed target')
  vm.staging_provider_census()
  vm.atomic(root/'accepted.json',json.dumps(target).encode())
  vm.atomic(vm.ISOLATION,json.dumps(target).encode())
  return target

if __name__=='__main__':
 os.umask(0o077)
 try:
  vm.need(os.geteuid()==0,'root required')
  print(json.dumps(refresh(**json.load(sys.stdin))))
 except Exception:
  print(json.dumps({'error':'reader update refused; preserve maintenance and exact prepared target'}));sys.exit(1)
