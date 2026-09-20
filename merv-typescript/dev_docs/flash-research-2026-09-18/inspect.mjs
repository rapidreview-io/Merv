import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
const directory=join(dirname(fileURLToPath(import.meta.url)), 'run');
const {token}=JSON.parse(readFileSync(join(directory,'server/credentials.json'),'utf8'));
const {baseUrl}=JSON.parse(readFileSync(join(directory,'connection.json'),'utf8'));
async function call(name,input={}) {
 const response=await fetch(`${baseUrl}/tools/${name}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input)});
 const data=await response.json();
 if(!response.ok) throw new Error(JSON.stringify({status:response.status,error:data}));
 return data.result;
}
const [tasks,experiments,reviews,cycles]=await Promise.all([
 call('task.list'),call('experiment.list'),call('review.list'),call('research.list')]);
const summarize=x=>({id:x.id,name:x.name??x.title,state:x.workflow?.state??x.state,status:x.status});
console.log(JSON.stringify({tasks:tasks.map(summarize),experiments:experiments.map(summarize),
 reviews:reviews.map(x=>({id:x.id,subject:x.subjectId,verdict:x.verdict,synopsis:x.synopsis})),
 cycles:cycles.map(summarize)},null,2));
