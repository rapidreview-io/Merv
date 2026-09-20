import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url));
const root=join(here,'run');
const {token}=JSON.parse(readFileSync(join(root,'server/credentials.json'),'utf8'));
const {baseUrl}=JSON.parse(readFileSync(join(root,'connection.json'),'utf8'));
const reviewId=process.argv[2];
if(!/^review_[a-f0-9]+$/.test(reviewId??''))throw new Error('Review id required');
async function request(path:string,body:any,method='POST') {
 const r=await fetch(`${baseUrl}${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
 const data:any=await r.json();if(!r.ok)throw new Error(JSON.stringify(data));return data;
}
const call=async(name:string,input:any)=>(await request(`/tools/${name}`,input)).result;
const review=await call('review.get',{reviewId});
if(review.verdict)throw new Error('Review already completed');
if(review.reviewerId)throw new Error('Review already claimed');
await request('/sessions/dispatch',{enabled:false},'PUT');
let actor:any;
try {
 actor=await call('actor.create',{name:`Flash independent interactive reviewer ${reviewId.slice(-6)}`,role:'reviewer',expiresAt:new Date(Date.now()+60*60*1000).toISOString()});
 const workspace=join(root,'interactive-reviews',reviewId);
 mkdirSync(workspace,{recursive:true,mode:0o700});
 const logs=join(root,'interactive-reviews');
 const stdout=join(logs,`${reviewId}.jsonl`),stderr=join(logs,`${reviewId}.stderr.log`);
 writeFileSync(stdout,'',{mode:0o600});writeFileSync(stderr,'',{mode:0o600});
 const allow=['actor.whoami','project.get','project.records','paper.read','task.get','experiment.get','experiment.get_state','experiment.exhibit','artifact.get','artifact.read','artifact.list','review.get','review.start','review.submit','feed.list'];
 const config:string[]=[];
 const c=(name:string,value:any)=>config.push('-c',`${name}=${JSON.stringify(value)}`);
 c('approval_policy','never');c('web_search','disabled');c('project_doc_max_bytes',0);c('allow_login_shell',false);
 for(const feature of ['apps','plugins','hooks','remote_plugin','multi_agent','multi_agent_v2','shell_snapshot','tool_suggest','skill_search','skill_mcp_dependency_install','browser_use','browser_use_external','computer_use','image_generation','in_app_local_automation'])c(`features.${feature}`,false);
 c('features.skip_host_skill_discovery',true);c('features.shell_tool',true);
 c('shell_environment_policy.inherit','none');
 c('mcp_servers.merv.url',`${baseUrl}/mcp`);
 c('mcp_servers.merv.bearer_token_env_var','MERV_AGENT_SESSION_TOKEN');
 c('mcp_servers.merv.required',true);c('mcp_servers.merv.startup_timeout_sec',120);
 c('mcp_servers.merv.enabled_tools',allow);c('mcp_servers.merv.default_tools_approval_mode','approve');
 const env:NodeJS.ProcessEnv={MERV_AGENT_SESSION_TOKEN:actor.token};
 for(const name of ['PATH','HOME','USER','SHELL','TMPDIR','LANG','LC_ALL'])if(process.env[name])env[name]=process.env[name];
 const child=spawn(join(here,'codex-flash-research'),['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--json','--color','never','-C',workspace,...config,'-'],{env,stdio:['pipe','pipe','pipe']});
 const redact=(s:string)=>s.replaceAll(actor.token,'[redacted]').replaceAll(token,'[redacted]');
 child.stdout.on('data',b=>appendFileSync(stdout,redact(b.toString())));
 child.stderr.on('data',b=>appendFileSync(stderr,redact(b.toString())));
 child.stdin.end(`You are a fresh DeepSeek Flash agent, independently reviewing one completed Merv experiment attempt. You did not produce its data, plan, code, results or report.\n\nUse the ordinary interactive review APIs: actor.whoami, review.get, review.start, inspect the exact pinned evidence, then review.submit with your own claimId, the pinned revision, substantive independent verification notes, and one finding per criterion. Your verdict is not prescribed. Pass only when the evidence and conclusions meet the criteria; otherwise return to the correct allowed state with actionable findings. Keep the synopsis under 350 characters. Stop after submitting the verdict.\n\nAutomatic assignment construction failed with context_too_large because it attempted to inline the evidence. This interactive review is the supported alternative: read the same immutable submission incrementally. You have a distinct project-bound reviewer identity, a read-only filesystem, no producer operations, and no deployment or source-code task. Do not change Merv application code. Do not use workflow.assignment to reconstruct the oversized package; review.get is the authoritative pinned contract.\n\nThe merv_files.inspect_artifact helper preserves your upstream permissions and returns hashes and verified localBlobPath for this local server. You may read those blobs with standard-library Python and decompress or parse in memory to recompute metrics, validate manifests, reconstruct prompts, and audit claims. No filesystem writes are needed. Verify evidence rather than merely restating assertions. Source artifact ids and review criteria must come from Merv.\n\nSupplemental operator evidence exists in artifact art_18d638429e994c29ae7542d31cdbbb63 (gzip JSONL of all exact broker requests and full provider responses) and art_40caca87bf2f495f9c0da6cfe077ead6 (provenance/settings manifest). It was retained from the original gateway without rerunning any calls. The feed explains its origin. You may use it as supplemental verification; use pinned evidence IDs in the review's findings as required by the contract.\n\nReview: ${reviewId}\nSubject: ${review.subjectId}\nPinned revision: ${review.subjectRevision}\nProject: ${review.projectId}\n`);
 const timer=setTimeout(()=>child.kill('SIGTERM'),25*60*1000);
 const exitCode=await new Promise<number|null>((done,reject)=>{child.once('error',reject);child.once('close',done);});
 clearTimeout(timer);
 const after=await call('review.get',{reviewId});
 const result={reviewId,actorId:actor.actor.id,exitCode,status:after.status,verdict:after.verdict,returnTo:after.returnTo,synopsis:after.synopsis,findings:after.findings};
 writeFileSync(join(logs,`${reviewId}.result.json`),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
 if(!after.verdict)process.exitCode=1;
} finally {
 if(actor?.credential?.id)await call('actor.revoke_token',{credentialId:actor.credential.id});
 await request('/sessions/dispatch',{enabled:true},'PUT');
}
