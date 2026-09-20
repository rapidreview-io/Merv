import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=dirname(fileURLToPath(import.meta.url));
const {token}=JSON.parse(readFileSync(join(dir,'run/server/credentials.json'),'utf8'));
const {baseUrl}=JSON.parse(readFileSync(join(dir,'run/connection.json'),'utf8'));
async function call(name,input) {
 const r=await fetch(`${baseUrl}/tools/${name}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input)});
 const data=await r.json();if(!r.ok)throw new Error(JSON.stringify(data));return data.result;
}
const artifact=await call('artifact.create',{title:'Independent operator audit of scores and interpretation limits',mediaType:'application/json',encoding:'utf8',content:readFileSync(join(dir,'independent-audit.json'),'utf8')});
await call('feed.post',{body:'I independently matched all 232 scored calls to the gateway and reproduced both bootstrap intervals. One interpretation needs care: finding a gold string in OCR does not prove its BIO field label is correct. The model_miss label alone cannot rule out annotation errors.',artifactIds:[artifact.id],requestId:'flash-study:operator-audit'});
writeFileSync(join(dir,'run/operator-audit-evidence.json'),JSON.stringify(artifact,null,2)+'\n');
console.log(JSON.stringify({artifactId:artifact.id,hash:artifact.hash}));
