#!/usr/bin/env python3
"""Exact candidate action inventory, native-client stage launcher, and call reconciliation."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import harness as h

HERE=Path(__file__).resolve().parent
SNAP=HERE/'candidate-4530'

def compact_items(path,value,key):
    # One schema/row per line keeps generated evidence diffs compact. The Markdown
    # view carries the reviewable prose; no schema constraints are discarded.
    header={k:v for k,v in value.items() if k!=key}
    prefix=json.dumps(header,separators=(',',':'))[:-1]
    Path(path).write_text(prefix + (',' if header else '') + '\n' + json.dumps(key)+':[' + '\n' + ',\n'.join(json.dumps(row,separators=(',',':')) for row in value[key]) + '\n]}\n')

def expand(value, root):
    if isinstance(value,dict):
        if '$ref' in value:
            ref=value['$ref']
            if not ref.startswith('#/'): raise ValueError('External schema ref unsupported')
            node=root
            for key in ref[2:].split('/'): node=node[key.replace('~1','/').replace('~0','~')]
            return {**expand(node,root),**{k:expand(v,root) for k,v in value.items() if k!='$ref'}}
        return {k:expand(v,root) for k,v in value.items() if k!='$defs'}
    if isinstance(value,list): return [expand(v,root) for v in value]
    return value

def actions(schema):
    return schema.get('properties',{}).get('action',{}).get('enum') or [None]

def action_schema(schema,action):
    props=schema.get('properties',{})
    if action and action in props: return props[action], 'nested'
    if action:
        for branch in schema.get('anyOf',[]) + schema.get('oneOf',[]):
            if branch.get('properties',{}).get('action',{}).get('const')==action or action in branch.get('properties',{}).get('action',{}).get('enum',[]):
                return {**schema, **branch, 'properties':{k:{**props.get(k,{}),**v} for k,v in branch['properties'].items()}}, 'flat'
    return schema, 'flat'

def availability(name):
    if name.startswith('feed.'): return 'disabled_in_default_config; no deploy enable switch in candidate renderer'
    if name.startswith('nisa.'): return 'conditional:MERV_NISA_API_KEY'
    if name.startswith('web.'): return 'conditional:MERV_TAVILY_API_KEY or MERV_WEB_FALLBACK_KEY_ENV'
    if name.startswith('history.'): return 'conditional:MERV_TS_LEGACY_SOURCE_ID; imported source required'
    if name=='sandboxes.access': return 'UI-tier; excluded from external discovery; worker access requires explicit actual lease-policy grant, not assignment alone'
    if name.startswith('sandboxes.'): return 'conditional:SANDBOXES_DATABASE_URL and configured host; no allocation implied'
    if name=='fleet': return 'conditional:MERV_FLEET_ENABLED and sandboxes'
    if name.startswith(('pi.','screen.')): return 'conditional:MERV_PI_ENABLED and fleet/sandboxes'
    if name.startswith(('intake.','customer_experiment.')): return 'conditional:MERV_CUSTOMER_EXPERIMENTS_ENABLED and Pi/workflow; bound request profile'
    return 'registered_by_default_composition; live role visibility must be verified'

def build(args):
    registrations=h.read(SNAP/'registered-tools.json'); published=h.read(SNAP/'operator-tools.json')
    if registrations['gaps']: raise ValueError('Extraction gaps must be resolved')
    recipes=h.read(HERE/'action-recipes.json')
    definitions={}; retired=[]
    for d in registrations['definitions']:
        schema=expand(d['schema'],d['schema'])
        for action in actions(schema):
            key=d['name']+(':'+action if action else '')
            desc=(d.get('actions') or {}).get(action,{})
            definitions[key]={**d,'action':action,'fullSchema':schema,'audience':desc.get('audience',d['audience']),'contract':desc.get('description',d['description']),'aliases':desc.get('aliases',[])}
        if d['removed']: retired.append({'tool':d['name'],'removed':d['removed'],'source':d['source']})
        if d['became']: retired.append({'tool':d['name'],'hiddenCachedCompatibility':d['became'],'source':d['source']})
    published_ids=[]
    for t in published['tools']:
        schema=expand(t['inputSchema'],t['inputSchema'])
        for action in actions(schema):
            key=t['name']+(':'+action if action else '');published_ids.append(key)
            d=definitions.get(key,{'source':'vendor/merv-sandboxes/typescript/packages/http/assets/mcp-tools.json','name':t['name'],'tier':'deferred','audience':'all','worker':None,'became':None,'aliases':[]})
            sub,style=action_schema(schema,action)
            definitions[key]={**d,'action':action,'fullSchema':schema,'contract':sub.get('description',t.get('description',''))}
    rows=[]
    for key,d in definitions.items():
        name=d['name'];action=d['action'];recipe=recipes.get(name)
        if not recipe or (action or 'call') not in recipe['steps']: raise ValueError('Missing explicit recipe: '+key)
        sub,style=action_schema(d['fullSchema'],action)
        required=[k for k in sub.get('required',[]) if k not in ('projectId','action')]
        fields={k:v for k,v in sub.get('properties',{}).items() if k not in ('projectId','action')}
        values={k:{'$bind':key+'.'+k} for k in required}
        # This is a binding template, not a fabricated executable request.
        template={'projectId':{'$bind':'projectId'}}
        if action: template['action']=action
        if style=='nested':template[action]=values
        else:template.update(values)
        lane='external_native_agent'
        if d['tier']=='ui': lane='website_only'
        elif d['became']:lane='cached_compatibility_only'
        elif d['tier']=='worker':lane='assigned_worker_only'
        elif d['audience']=='conversations':lane='pi_or_assigned_worker'
        if name.startswith('intake.'):lane='bound_intake_pi_only'
        if name=='screen.read':lane='internal_pi_only'
        # The pinned registration snapshot's manually supplemented SSH tier was
        # mislabeled worker; actual legacy conversation:'never' maps to UI.
        if name=='sandboxes.access':lane='ui_or_explicit_worker_grant'
        rows.append({'id':key,'tool':name,'action':action,'stage':recipe['group'],'lane':lane,'availability':availability(name),'inMeasuredOperatorListing':key in published_ids,'source':d['source'],'aliases':d['aliases'],'contract':d['contract'],'inputStyle':style,'requiredFields':required,'inputFields':fields,'argumentTemplate':template,'fixture':recipe['fixture'],'operation':recipe['steps'][action or 'call'],'independentEvidence':recipe['verify'],'checks':['native_action_observed','domain_result_verified','independent_readback','cleanup_recorded'],'initialStatus':'not_run'})
    # Each stage is a bounded coherent agent prompt; stateful workflows may revisit it.
    tool_order={'artifact.write':['create','upload_begin','upload_resume','upload_complete'],'review.write':['start','release','submit'],'code.write':['repository_configure','repository_prepare','publication_sync','base_suspend','base_resume','base_retry','base_quarantine','base_release','base_repair','unit_fence','base_cancel'],'research.write':['create','replan','advance','end'],'sandboxes.storage':['upload','resume','complete','manifest','get','list','download','usage','delete'],'sandboxes.sandbox':['options','providers','list','get','events','create','renew','delete'],'sandboxes.snapshot':['list','create','get','restore','delete']}
    rows.sort(key=lambda r:(r['stage'],r['tool'],tool_order.get(r['tool'],[]).index(r['action']) if r['action'] in tool_order.get(r['tool'],[]) else list(recipes[r['tool']]['steps']).index(r['action'] or 'call')))
    for i,r in enumerate(rows,1):r['sequence']=i
    matrix={'schemaVersion':1,'candidateRevision':registrations['candidateRevision'],'kind':'preparation_not_execution','sources':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [SNAP/'operator-tools.json',SNAP/'registered-tools.json',HERE/'action-recipes.json']},'measurement':'Existing tool-list-size fixture on loopback PostgreSQL ephemeral schemas; optional Feed/Nisa/Web/Sandboxes definitions enabled. Registration-only extractor supplements worker/Pi/UI/history/Fleet/intake schemas; no handlers called. Neither proves deployed availability.','retiredOrHidden':retired,'publishedActionCount':len(published_ids),'rows':rows}
    compact_items(SNAP/'action-matrix.json',matrix,'rows')
    lines=['# Candidate action matrix','',f"Candidate `{matrix['candidateRevision']}`. {len(rows)} exact action/tool rows; {len(published_ids)} in measured operator listing. Every row starts **not_run**. Full contracts, field schemas, binding templates and fixtures are in action-matrix.json.",'','| Order | Exact tool/action | Lane / availability | Minimal operation | Independent evidence |','|---|---|---|---|---|']
    for r in rows:
        clean=lambda s:str(s).replace('|','\\|').replace('\n',' ')
        lines.append('| '+' | '.join(map(clean,[r['sequence'],r['id'],r['lane']+' / '+r['availability'],r['operation'],r['independentEvidence']]))+' |')
    (SNAP/'ACTION_MATRIX.md').write_text('\n'.join(lines)+'\n')
    print(json.dumps({'rows':len(rows),'publishedActions':len(published_ids),'stages':len(set(r['stage'] for r in rows))}))

def stage(args):
    matrix=h.read(SNAP/'action-matrix.json');rows=[r for r in matrix['rows'] if r['stage']==args.stage]
    if not rows:raise ValueError('Unknown stage')
    # UI, Pi and worker roles must be exercised by their genuine surfaces, never an owner impersonation.
    runnable=[r for r in rows if r['lane']=='external_native_agent']
    if not runnable:raise ValueError('Stage requires genuine UI/Pi/assigned-worker execution; use its matrix recipes and retain receipts')
    bindings=h.read(args.bindings) if args.bindings else {}
    prompt='Execute these exact native tool/action checks sequentially using the retained run fixture IDs. Resolve binding placeholders from actual current records, never fabricate them. Read the live tool schema first: a candidate mismatch is blocked and must be reconciled. Preserve default approval and reviewer boundaries. Execute only operations whose documented prerequisites already exist; return blocked per missing prerequisite, disabled capability, role restriction or missing budget. Do not provision compute, enable dispatch, purchase services or create credentials. Ordinary signed byte transport is permitted only as directed by actual artifact tools, never a direct HTTP substitute for a domain action. Independent observer readback is required before an acceptance pass.\n'
    prompt+=json.dumps({'candidateRevision':matrix['candidateRevision'],'fixtureBindings':bindings,'steps':runnable,'otherLanesStillRequired':[r['id'] for r in rows if r not in runnable]},indent=2)
    entry={'id':'actions-'+args.stage,'prompt':prompt,'checks':[r['id']+'/'+c for r in runnable for c in r['checks']]}
    return h.run(argparse.Namespace(root=args.root,client=args.client,scenario=entry['id'],entry=entry,resume=args.resume,dry_run=not args.execute,timeout=args.timeout))

def observed_calls(paths, rows):
    mapping={}
    for r in rows:
        for name in (r['tool'],r['tool'].replace('.','_')):mapping[name]=r['tool']
    calls=[]
    for path in paths:
        for n,line in enumerate(Path(path).read_text().splitlines(),1):
            try:d=json.loads(line)
            except ValueError:continue
            nodes=[]
            item=d.get('item',{})
            if d.get('type')=='item.completed' and item.get('type')=='mcp_tool_call':nodes.append((item.get('tool',''),item.get('arguments',{}),'completed' if item.get('status')=='completed' and not item.get('error') and not (item.get('result',{}).get('isError') if isinstance(item.get('result'),dict) else False) else 'failed_or_unknown'))
            content=(d.get('message') or {}).get('content',[])
            if isinstance(content,list):
                for c in content:
                    if isinstance(c,dict) and c.get('type')=='tool_use':nodes.append((c.get('name',''),c.get('input',{}),'attempted_result_unverified'))
            for name,values,status in nodes:
                # Native plugin namespaces can differ; only exact known tool suffixes match.
                suffix=name.split('__')[-1]
                canonical=mapping.get(name) or mapping.get(suffix)
                if not canonical:continue
                if isinstance(values,str):
                    try:values=json.loads(values)
                    except ValueError:values={}
                action=values.get('action') if isinstance(values,dict) else None
                key=canonical+(':'+action if isinstance(action,str) else '')
                calls.append({'id':key,'status':status,'proofPath':str(Path(path).resolve()),'line':n})
    return calls

def reconcile(args):
    matrix=h.read(SNAP/'action-matrix.json'); rows=matrix['rows'];calls=observed_calls(args.transcripts,rows)
    discovery=h.read(args.discovery) if args.discovery else None
    live=[]
    if discovery:
        # Input must be actual native-client retained discovery, not this preparation snapshot.
        for t in discovery['tools']:
            schema=expand(t['inputSchema'],t['inputSchema'])
            live += [t['name']+(':'+a if a else '') for a in actions(schema)]
    expected={r['id'] for r in rows if r['lane']=='external_native_agent'}
    result={'candidateRevision':matrix['candidateRevision'],'kind':'observations_not_acceptance','nativeDiscoveryProof':str(Path(args.discovery).resolve()) if args.discovery else None,'nativeDiscoverySha256':hashlib.sha256(Path(args.discovery).read_bytes()).hexdigest() if args.discovery else None,'newLiveActions':sorted(set(live)-expected),'absentFromLive':sorted(expected-set(live)) if discovery else None,'unknownObservedActions':sorted({c['id'] for c in calls}-{r['id'] for r in rows}),'rows':[{'id':r['id'],'lane':r['lane'],'availability':r['availability'],'status':'observed_not_verified' if any(c['id']==r['id'] for c in calls) else 'not_observed','calls':[c for c in calls if c['id']==r['id']]} for r in rows]}
    h.write(args.output,result);print(args.output)

def main():
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(required=True)
    q=sub.add_parser('build');q.set_defaults(fn=build)
    q=sub.add_parser('stage');q.add_argument('root');q.add_argument('--stage',required=True);q.add_argument('--client',choices=['codex','claude'],required=True);q.add_argument('--bindings');q.add_argument('--resume');q.add_argument('--timeout',type=int,default=600);q.add_argument('--execute',action='store_true');q.set_defaults(fn=stage)
    q=sub.add_parser('reconcile');q.add_argument('output');q.add_argument('transcripts',nargs='+');q.add_argument('--discovery');q.set_defaults(fn=reconcile)
    args=p.parse_args()
    if hasattr(args,'timeout') and not 1<=args.timeout<=1800:p.error('timeout must be 1..1800')
    try:return args.fn(args) or 0
    except (ValueError,KeyError,OSError) as e:print(h.redact(str(e)),file=sys.stderr);return 2
if __name__=='__main__':sys.exit(main())
