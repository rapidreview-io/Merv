import { createServer } from 'node:http';
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// A bounded public-data inference endpoint. Workers never need the provider key.
export async function startInferenceBroker(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = readFileSync('/Users/guraltoo/.codex/credentials/deepseek-api-key', 'utf8').trim();
  let count = 0, active = 0, promptTokens = 0, completionTokens = 0;
  const cache = new Map<string, unknown>();
  const journal = join(directory,'receipts.jsonl');
  if (existsSync(journal)) for (const line of readFileSync(journal,'utf8').split('\n').filter(Boolean)) {
    const r=JSON.parse(line);
    count=Math.max(count,r.number??0);
    promptTokens+=r.response?.usage?.prompt_tokens??0;
    completionTokens+=r.response?.usage?.completion_tokens??0;
    if(r.status>=200&&r.status<300&&r.response)
      cache.set(r.digest,{...r.response,brokerReceipt:{number:r.number,digest:r.digest,elapsedMs:r.elapsedMs}});
  }
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/status') {
      return reply(200, { model: 'deepseek-flash', count, active, promptTokens, completionTokens, maxCalls: 400 });
    }
    if (req.method !== 'POST' || req.url !== '/extract') return reply(404, {error:'not_found'});
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 48000) return reply(413, {error:'request_too_large'});
    }
    let input: any;
    try { input = JSON.parse(body); } catch { return reply(400, {error:'invalid_json'}); }
    if (!Array.isArray(input.messages) || input.messages.length > 12 || !input.messages.every((m: any) =>
      ['system','user','assistant'].includes(m.role) && typeof m.content === 'string'))
      return reply(400, {error:'messages_required'});
    const payload = { model:'deepseek-flash', messages:input.messages, temperature:0,
      max_tokens:768, thinking:{type:'disabled'}, response_format:{type:'json_object'} };
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    if (cache.has(digest)) return reply(200, { ...(cache.get(digest) as object), brokerCache:true });
    if (count >= 400 || promptTokens >= 1_500_000 || completionTokens >= 250_000)
      return reply(429, {error:'study_budget_exhausted'});
    if (active >= 4) return reply(429, {error:'concurrency_limit',retryAfterSeconds:2});
    count++; active++;
    const number=count, started=Date.now();
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method:'POST', headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},
        body:JSON.stringify(payload), signal:AbortSignal.timeout(120_000)
      });
      const data:any = await response.json();
      const record={number,digest,at:new Date(started).toISOString(),elapsedMs:Date.now()-started,
        status:response.status,request:payload,response:data};
      appendFileSync(join(directory,'receipts.jsonl'),JSON.stringify(record)+'\n',{mode:0o600});
      promptTokens += data.usage?.prompt_tokens ?? 0;
      completionTokens += data.usage?.completion_tokens ?? 0;
      const result={...data,brokerReceipt:{number,digest,elapsedMs:record.elapsedMs}};
      if (response.ok) cache.set(digest,result);
      reply(response.status,result);
    } catch (error) {
      appendFileSync(join(directory,'receipts.jsonl'),JSON.stringify({number,digest,error:String(error),at:new Date().toISOString()})+'\n',{mode:0o600});
      reply(502,{error:'upstream_failed',number});
    } finally { active--; }
  });
  await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(18763,'127.0.0.1',done);});
  return {
    close:async()=>{
      writeFileSync(join(directory,'usage.json'),JSON.stringify({count,promptTokens,completionTokens,maxCalls:400},null,2)+'\n');
      await new Promise<void>(done=>server.close(()=>done()));
    }
  };
}
