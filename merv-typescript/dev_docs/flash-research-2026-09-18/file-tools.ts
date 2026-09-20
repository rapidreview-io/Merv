import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync, realpathSync, lstatSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { uploadArtifact } from '../../src/artifact-upload.js';

const workspace=realpathSync(process.argv[2]);
const readOnly=process.argv[3]==='read-only';
const token=process.env.MERV_AGENT_SESSION_TOKEN!;
if(!token) throw new Error('Missing scoped session credential');
const url='http://127.0.0.1:18764/mcp';
const client=new Client({name:'flash-study-artifact-files',version:'1'});
await client.connect(new StreamableHTTPClientTransport(new URL(url),{
  requestInit:{headers:{authorization:`Bearer ${token}`},redirect:'error'}
}));
function safePath(value:string,writing=false) {
  const path=resolve(workspace,value);
  const actual=writing?resolve(realpathSync(dirname(path)),path.split(sep).at(-1)!):realpathSync(path);
  if(!actual.startsWith(workspace+sep)) throw new Error('Path must be inside this assigned workspace');
  if(!writing && !lstatSync(actual).isFile()) throw new Error('Regular file required');
  return actual;
}
async function bytes(artifactId:string) {
 const result:any=await client.callTool({name:'artifact.read',arguments:{artifactId}});
 if(result.isError) throw new Error(result.content?.[0]?.text??'Merv refused artifact read');
 const data=JSON.parse(result.content.find((c:any)=>c.type==='text').text);
 // Current artifact.read returns metadata plus its encoded content.
 const content=data.content;
 if(typeof content!=='string') throw new Error('Unsupported artifact content envelope');
 return {data,body:Buffer.from(content,data.encoding==='base64'?'base64':'utf8')};
}
function tarMembers(input:Buffer) {
 const members: {name:string,body:Buffer}[]=[];
 const raw=input[0]===0x1f&&input[1]===0x8b?gunzipSync(input,{maxOutputLength:32*1024*1024}):input;
 for(let pos=0;pos+512<=raw.length;) {
  const header=raw.subarray(pos,pos+512);
  if(header.every(b=>b===0)) break;
  const name=header.subarray(0,100).toString().replace(/\0.*$/s,'');
  const size=parseInt(header.subarray(124,136).toString().replace(/\0/g,'').trim()||'0',8);
  if(!Number.isFinite(size)||size<0||pos+512+size>raw.length) throw new Error('Invalid tar member');
  if(header[156]===0||header[156]===48) members.push({name,body:raw.subarray(pos+512,pos+512+size)});
  pos+=512+Math.ceil(size/512)*512;
 }
 return members;
}
const textResult=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}]});
const server=new Server({name:'merv-files',version:'1'},{capabilities:{tools:{}},instructions:
 'Transfer immutable files without copying binary/base64 through model output. All upstream calls use your same scoped Merv lease and remain subject to its permissions. For upload, pass an existing file within your assigned workspace; receipt hashes are verified. Read-only reviewers can inspect artifact bytes or archive members in memory. This is a local transport helper, not a bypass of research or review gates.'});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
 ...(!readOnly?[
  {name:'upload_file',description:'Upload an existing file (up to 2 MB) from your assigned workspace through Merv artifact.create and verify its exact hash. Prefer this over retyping file content. Binary .tar.gz bundles are supported; no need to split into base64 text parts.',inputSchema:{type:'object',properties:{path:{type:'string'},title:{type:'string'},mediaType:{type:'string'}},required:['path','title'],additionalProperties:false}},
  {name:'download_artifact',description:'Save an existing Merv artifact into a new file in your assigned workspace, preserving exact bytes. Parent directory must exist. Returns hash and byte count.',inputSchema:{type:'object',properties:{artifactId:{type:'string'},path:{type:'string'}},required:['artifactId','path'],additionalProperties:false}}
 ]:[]),
 {name:'inspect_artifact',description:'Read artifact bytes without filesystem writes. mode=metadata gives hash/size and, for this local study, a hash-verified localBlobPath that can be opened read-only for independent in-memory computation with Python. text gives UTF-8; archive_list lists tar/tar.gz members; archive_member returns one member as UTF-8. Text output limited to 60,000 characters.',inputSchema:{type:'object',properties:{artifactId:{type:'string'},mode:{type:'string',enum:['metadata','text','archive_list','archive_member']},member:{type:'string'}},required:['artifactId','mode'],additionalProperties:false}}
]}));
server.setRequestHandler(CallToolRequestSchema,async(request)=>{
 try {
  const a:any=request.params.arguments??{};
  if(request.params.name==='upload_file'&&!readOnly) {
   return textResult(await uploadArtifact({url,file:safePath(a.path),token,title:a.title,mediaType:a.mediaType}));
  }
  const {data,body}=await bytes(a.artifactId);
  const metadata:any={artifactId:a.artifactId,size:body.length,sha256:createHash('sha256').update(body).digest('hex')};
  const stored=data.artifact;
  if(/^project_[a-f0-9]+$/.test(stored?.projectId??'') && /^[a-f0-9]{64}$/.test(stored?.hash??'')) {
    const candidate=resolve(dirname(fileURLToPath(import.meta.url)),'run/server/blobs',stored.projectId,stored.hash.slice(0,2),stored.hash);
    if(existsSync(candidate) && createHash('sha256').update(readFileSync(candidate)).digest('hex')===metadata.sha256)
      metadata.localBlobPath=candidate;
  }
  if(request.params.name==='download_artifact'&&!readOnly) {
   const path=safePath(a.path,true);writeFileSync(path,body,{flag:'wx',mode:0o600});return textResult({...metadata,path});
  }
  if(request.params.name!=='inspect_artifact') throw new Error('Tool not allowed');
  if(a.mode==='metadata')return textResult(metadata);
  if(a.mode==='text')return textResult({...metadata,text:body.toString('utf8').slice(0,60000),truncated:body.toString('utf8').length>60000});
  let packed=body;
  if(body.subarray(0,4).toString()==='H4sI')packed=Buffer.from(body.toString().trim(),'base64');
  const entries=tarMembers(packed);
  if(a.mode==='archive_list')return textResult({...metadata,members:entries.map(e=>({name:e.name,size:e.body.length,sha256:createHash('sha256').update(e.body).digest('hex')}))});
  const found=entries.find(e=>e.name===a.member);
  if(!found)throw new Error('Archive member not found');
  return textResult({...metadata,member:found.name,memberSha256:createHash('sha256').update(found.body).digest('hex'),text:found.body.toString('utf8').slice(0,60000),truncated:found.body.toString('utf8').length>60000});
 } catch(error) {return {isError:true,content:[{type:'text',text:String(error).replaceAll(token,'[redacted]')}]};}
});
await server.connect(new StdioServerTransport());
