import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {createApp} from '../src/app.js'

async function client(url:string,token:string) {
  const result=new Client({name:'merv-integration',version:'1.0.0'})
  await result.connect(new StreamableHTTPClientTransport(new URL(url+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}))
  return result
}
async function call(c:Client,name:string,args:Record<string,unknown>={}) {
  const result=await c.callTool({name,arguments:args})
  const contents=result.content as {type:string;text:string}[]
  assert.equal(result.isError,undefined,JSON.stringify(contents))
  return JSON.parse(contents[0].text)
}
test('assembled Cordis application completes MCP task review across two full restarts',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'merv-app-'))
  let app=await createApp({directory,api:true,port:0})
  let producer:Client|undefined,reviewer:Client|undefined
  try {
    const credentials=app.ctx.scope.bootstrap({projectName:'Integration',actorName:'Operator'})
    const caller={actorId:credentials.actor.id,projectId:credentials.project.id}
    const p=app.ctx.scope.issueActor(caller,{name:'Producer',role:'producer'}),r=app.ctx.scope.issueActor(caller,{name:'Reviewer',role:'reviewer'})
    producer=await client(app.ctx.api.url!,p.token)
    assert.equal((await producer.listTools()).tools.length,26)
    const brief=await call(producer,'artifact.create',{title:'Brief',content:'Goal: Verify arithmetic.\nDone when: Sum is 20.'})
    const task=await call(producer,'task.create',{title:'Arithmetic',goal:'Verify arithmetic.',checks:['Sum is 20.'],briefId:brief.id,requestId:'create'})
    const delivery=await call(producer,'artifact.create',{title:'Delivery',content:'Sum is 20. Calculation: 2+4+6+8=20.'})
    const submitted=await call(producer,'task.submit_delivery',{taskId:task.id,artifactIds:[delivery.id],expectedRevision:0,requestId:'submit'})
    assert.equal(submitted.workflow.state,'in_review')
    const rejected=await producer.callTool({name:'review.start',arguments:{reviewId:submitted.reviewId}})
    assert.equal(rejected.isError,true)
    await producer.close();producer=undefined;await app.stop()
    app=await createApp({directory,api:true,port:0})
    reviewer=await client(app.ctx.api.url!,r.token)
    const pin=await call(reviewer,'review.get',{reviewId:submitted.reviewId})
    assert.deepEqual(pin.artifactIds,[brief.id,delivery.id])
    assert.equal((await call(reviewer,'artifact.read',{artifactId:delivery.id})).content,'Sum is 20. Calculation: 2+4+6+8=20.')
    await call(reviewer,'review.start',{reviewId:pin.id})
    const verdictArgs={reviewId:pin.id,verdict:'pass',notes:'Read the immutable delivery and independently verified 2+4+6+8=20.',expectedRevision:1,requestId:'verdict'}
    const done=await call(reviewer,'review.submit',verdictArgs)
    assert.equal(done.workflow.state,'done')
    assert.deepEqual(await call(reviewer,'review.submit',verdictArgs),done)
    await reviewer.close();reviewer=undefined;await app.stop()
    app=await createApp({directory,api:true,port:0})
    assert.equal(app.ctx.tasks.get(caller,task.id).workflow.revision,2)
    assert.equal(app.ctx.reviews.get(caller,pin.id).reviewerId,r.actor.id)
    assert.equal(app.ctx.state.events(caller.projectId).filter(e=>e.type==='task.review_applied').length,1)
    assert.equal(app.ctx.artifacts.read(caller,delivery.id).content,'Sum is 20. Calculation: 2+4+6+8=20.')
  } finally {await producer?.close();await reviewer?.close();await app.stop();rmSync(directory,{recursive:true,force:true})}
})
test('invalid composition fails without leaving an active application',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'merv-invalid-'))
  try{await assert.rejects(createApp({directory,components:['artifacts']}),/missing dependencies/)}finally{rmSync(directory,{recursive:true,force:true})}
})
test('application stop disposes Cordis and SQLite after API shutdown rejects',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'merv-stop-failure-'))
  const app=await createApp({directory,api:true,port:0})
  const state=app.ctx.state,api=app.ctx.api
  const originalStop=api.stop.bind(api)
  const failure=new Error('Injected transport shutdown failure')
  let attempts=0
  api.stop=async()=>{if(++attempts === 1)throw failure;await originalStop()}
  try {
    const stopped=app.stop()
    assert.equal(app.stop(),stopped,'Concurrent stop requests must join the same shutdown')
    await assert.rejects(stopped,error=>error === failure)
    assert.equal(attempts,2,'Cordis must run the API resource disposer after the first failure')
    assert.equal(app.ctx.get('state'),undefined)
    assert.equal(app.ctx.get('tasks'),undefined)
    assert.equal(app.ctx.get('api'),undefined)
    assert.throws(()=>state.read(sql=>sql.get('SELECT 1')),/State is closed/)
  } finally {
    await originalStop()
    await app.ctx.fiber.dispose()
    rmSync(directory,{recursive:true,force:true})
  }
})
