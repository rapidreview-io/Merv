/** Registration-only schema extraction. No service handler or network calls. */
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const root = resolve(process.argv[2]!);
const out = resolve(process.argv[3]!);
const load = (path: string) => import(pathToFileURL(join(root, path)).href);
const { describeTool } = await load('packages/api/src/registry.ts');
const { noun } = await load('packages/api/src/noun.ts');
const definitions: any[] = [], gaps: any[] = [];
let source = '';
const inert = new Proxy({}, { get: (_, key) => (..._args: any[]) => { throw new Error(`Service invoked during extraction: ${String(key)}`); } });
const tools = {
  contributeContext() { return () => {}; },
  contributePicture() { return () => {}; },
  contributeInstructions() { return () => {}; },
  alias() { return () => {}; },
  register(d: any) { definitions.push({ source, definition: d }); return () => {}; },
  noun(name: string, d: any) { definitions.push({ source, definition: noun(name, d) }); return () => {}; },
};
const ctx = new Proxy({ tools, effect(f: any) { const r=f(); if(r?.next) for (const _ of r) {} return () => {}; } }, { get: (target, key) => (target as any)[key] ?? inert });
for (const dir of readdirSync(join(root, 'packages'))) {
  source=`packages/${dir}/src/tools.ts`;
  try { readFileSync(join(root,source)); } catch { continue; }
  try {
    const mod=await load(source);
    const plugin=mod.default ?? Object.values(mod).find((v:any)=>typeof v?.apply==='function');
    if(plugin) await plugin.apply(ctx, {sourceId:'acceptance-archive'});
    else if(mod.nisaTools) for(const d of mod.nisaTools(inert)) 'inputSchema' in d ? tools.register(d) : tools.noun(d.name,d);
    else if(mod.webTools) { const d=mod.webTools({reads:true});tools.noun(d.name,d); }
    else gaps.push({source,reason:'No supported registration entrypoint'});
  } catch(e:any) { gaps.push({source,reason:e.message}); }
}
source='packages/customer-experiments/src/worker-tools.ts';
(await load(source)).registerWorkerTools(tools,inert,inert);
source='packages/customer-experiments/src/service.ts';
const {CustomerService}=await load(source);
const service=Object.create(CustomerService.prototype);
Object.assign(service,{pi:{registerProfile:()=>()=>{}},artifacts:{registerFileProvider:()=>()=>{}},options:{}});
try { await service.registerIntake(tools); } catch(e:any) { gaps.push({source,reason:e.message}); }
// SSH access is intentionally absent from the external-agent listing, but remains
// a worker capability. Retain its exact vendored schema without calling a handler.
const vendorTools=JSON.parse(readFileSync(join(process.argv[4] ? resolve(process.argv[4]) : join(root,'vendor/merv-sandboxes'),'typescript/packages/http/assets/mcp-tools.json'),'utf8'));
const ssh=vendorTools.find((t:any)=>t.name==='access');
const records=definitions.map(({source,definition:d})=>({
  source, name:d.name, tier:d.tier??'deferred', audience:d.for??'all', worker:d.worker??null,
  became:d.became??null, removed:d.removed??[], readOnly:!!d.readOnly,
  schema:describeTool(d).inputSchema, description:d.description,
  actions:d.actions ? Object.fromEntries(Object.entries(d.actions).map(([action,a]:any)=>[action,{description:a.description,readOnly:!!(d.readOnly||a.readOnly),audience:a.for??d.for??'all',aliases:a.was??[]}])) : null,
}));
records.push({source:'vendor/merv-sandboxes/typescript/hosts/merv/src/tools.ts',name:'sandboxes.access',tier:'ui',audience:'all',worker:null,became:null,removed:[],readOnly:false,schema:ssh.inputSchema,description:ssh.description,actions:null});
writeFileSync(out,JSON.stringify({kind:'registration_only_not_execution',candidateRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),gaps,definitions:records},null,2)+'\n');
console.log(JSON.stringify({definitions:records.length,gaps}));
