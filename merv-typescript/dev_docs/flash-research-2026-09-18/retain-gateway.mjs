import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'run');
const {token}=JSON.parse(readFileSync(join(root,'server/credentials.json'),'utf8'));
const {baseUrl}=JSON.parse(readFileSync(join(root,'connection.json'),'utf8'));
const raw=readFileSync(join(root,'inference/receipts.jsonl'));
const rows=raw.toString('utf8').trim().split('\n').map(JSON.parse);
const settings={model:'deepseek-flash',temperature:0,max_tokens:768,thinking:{type:'disabled'},response_format:{type:'json_object'}};
for(const row of rows) {
 for(const [key,value] of Object.entries(settings))
  if(JSON.stringify(row.request?.[key])!==JSON.stringify(value))throw new Error('Gateway setting mismatch');
 if(row.status!==200||!row.response?.id||!row.response?.choices?.length)throw new Error('Incomplete gateway receipt');
 if(createHash('sha256').update(JSON.stringify(row.request)).digest('hex')!==row.digest)throw new Error('Gateway request digest mismatch');
}
const packed=gzipSync(raw,{mtime:0});
if(packed.length>180000)throw new Error('Partition gateway evidence before upload');
async function call(name,input) {
 const r=await fetch(`${baseUrl}/tools/${name}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input)});
 const data=await r.json();if(!r.ok)throw new Error(JSON.stringify(data));return data.result;
}
const receipt=await call('artifact.create',{title:'Operator gateway evidence — all 237 exact public-data requests and full provider responses',mediaType:'application/gzip',encoding:'base64',content:packed.toString('base64')});
const manifest={origin:'Operator inference broker; independent of executor reporting. Unmodified gateway journal, not a re-run.',
 createdAt:new Date().toISOString(),count:rows.length,firstRequestAt:rows[0].at,lastRequestAt:rows.at(-1).at,
 rawSha256:createHash('sha256').update(raw).digest('hex'),gzipSha256:createHash('sha256').update(packed).digest('hex'),
 size:packed.length,settings,everySettingMatches:true,everyRequestDigestMatches:true,
 allFullResponsesRetained:true,artifact:receipt,decode:'gzip.decompress(bytes) -> UTF-8 JSON lines',
 note:'Each row contains number, digest, request time, elapsedMs, HTTP status, exact request and full response. No credentials are stored.'};
if(receipt.hash!==manifest.gzipSha256)throw new Error('Stored gateway receipt mismatch');
const meta=await call('artifact.create',{title:'Operator gateway provenance and exact inference settings',mediaType:'application/json',encoding:'utf8',content:JSON.stringify(manifest,null,2)});
await call('feed.post',{body:'All 237 provider receipts are retained, including exact request settings and response IDs, for independent verification.',artifactIds:[receipt.id,meta.id],requestId:'flash-study:gateway-receipts'});
writeFileSync(join(root,'gateway-evidence.json'),JSON.stringify({...manifest,manifestArtifact:meta},null,2)+'\n');
console.log(JSON.stringify({count:rows.length,compressedBytes:packed.length,artifactId:receipt.id,manifestArtifactId:meta.id}));
