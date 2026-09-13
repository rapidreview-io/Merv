import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { SqliteState, statePlugin } from '@merv/state'
import { DiskBlobs, blobsPlugin } from '@merv/blobs'
import { ProjectScope, scopePlugin } from '@merv/scope'
import { ArtifactStore, artifactsPlugin } from '@merv/artifacts'
import type { Transaction } from '@merv/contracts'

function fixture(t:any) {
  const dir=mkdtempSync(join(tmpdir(),'merv-foundation-'))
  const state=new SqliteState(join(dir,'state.sqlite'))
  t.after(()=>{state.close();rmSync(dir,{recursive:true,force:true})})
  const scope=new ProjectScope(state),blobs=new DiskBlobs(join(dir,'blobs')),artifacts=new ArtifactStore(state,scope,blobs)
  const admin=scope.bootstrap({projectName:'First project',actorName:'Operator'})
  const caller={actorId:admin.actor.id,projectId:admin.project.id}
  return {dir,state,scope,blobs,artifacts,admin,caller}
}
test('component migrations are independent, immutable, atomic and persistent',t=>{
  const {dir,state}=fixture(t)
  const a=[{version:1,sql:'CREATE TABLE sample(id TEXT PRIMARY KEY);'}]
  state.migrate('sample',a);state.migrate('sample',a)
  state.migrate('other',[{version:1,sql:'CREATE TABLE other(id TEXT PRIMARY KEY);'}])
  assert.throws(()=>state.migrate('sample',[{version:1,sql:'CREATE TABLE changed(id TEXT);'}]),/changed/)
  assert.throws(()=>state.migrate('failure',[{version:1,sql:'CREATE TABLE undone(id TEXT); INSERT INTO missing VALUES(1);'}]))
  assert.equal(state.read(sql=>sql.get("SELECT name FROM sqlite_master WHERE name='undone'")),undefined)
  let tx:Transaction|undefined
  assert.throws(()=>state.transaction(current=>{tx=current;current.run('INSERT INTO sample VALUES(?)','rollback');throw new Error('abort')}),/abort/)
  assert.throws(()=>tx!.run('INSERT INTO sample VALUES(?)','late'),/no longer active/)
  assert.equal(state.read(sql=>sql.get('SELECT * FROM sample')),undefined)
  assert.throws(()=>state.transaction(async()=>{throw new Error('should never execute')}),/synchronous/)
  assert.throws(()=>state.transaction(()=>Promise.reject(new Error('contained rejection'))),/synchronous/)
  state.transaction(tx=>tx.run('INSERT INTO sample VALUES(?)','retained'))
  const second=new SqliteState(join(dir,'state.sqlite'))
  try { assert.equal(second.read(sql=>sql.get<{id:string}>('SELECT id FROM sample'))?.id,'retained') } finally {second.close()}
})
test('events commit with the transaction and survive reopening',t=>{
  const {state,caller,dir}=fixture(t)
  const before=state.events(caller.projectId).length
  assert.throws(()=>state.transaction(tx=>{state.appendEvent(tx,{...caller,type:'rollback',subjectId:'x',data:{}});throw new Error('abort')}))
  assert.equal(state.events(caller.projectId).length,before)
  state.transaction(tx=>state.appendEvent(tx,{...caller,type:'committed',subjectId:'y',data:{number:1}}))
  const second=new SqliteState(join(dir,'state.sqlite'))
  try {assert.equal(second.events(caller.projectId).at(-1)?.type,'committed')}finally{second.close()}
})
test('credentials enforce roles, project boundaries and revocation',t=>{
  const {scope,caller,admin}=fixture(t)
  assert.equal(scope.authenticate(admin.token).id,caller.actorId)
  const reviewer=scope.issueActor(caller,{name:'Reviewer',role:'reviewer'})
  const rc={actorId:reviewer.actor.id,projectId:caller.projectId}
  scope.require(rc,'review');assert.throws(()=>scope.require(rc,'write'),/lacks write/)
  const other=scope.bootstrap({projectName:'Second project',actorName:'Other'})
  assert.throws(()=>scope.require({...caller,projectId:other.project.id},'read'),/cannot access/)
  assert.throws(()=>scope.issueActor(rc,{name:'Escalated',role:'operator'}),/lacks admin/)
  scope.revokeActor(caller,reviewer.actor.id)
  assert.throws(()=>scope.authenticate(reviewer.token),/revoked/)
  assert.throws(()=>scope.require(rc,'read'),/cannot access/)
})
test('artifacts retain exact bytes, reject mutation, scope reads and detect corruption',t=>{
  const {artifacts,blobs,caller,state,scope,dir}=fixture(t)
  const value=artifacts.create(caller,{title:'Evidence',content:'retained content'})
  assert.equal(artifacts.read(caller,value.id).content,'retained content')
  assert.equal(artifacts.create(caller,{title:'Same content',content:'retained content'}).hash,value.hash)
  assert.throws(()=>state.transaction(tx=>tx.run('UPDATE artifacts SET title=? WHERE id=?','changed',value.id)),/immutable/)
  assert.throws(()=>state.transaction(tx=>tx.run('INSERT OR REPLACE INTO artifacts SELECT id,project_id,created_by,?,media_type,hash,size,created_at FROM artifacts WHERE id=?','replaced',value.id)),/immutable/)
  const other=scope.bootstrap({projectName:'Other',actorName:'Other'})
  assert.throws(()=>artifacts.get({actorId:other.actor.id,projectId:other.project.id},value.id),/not found/)
  assert.throws(()=>blobs.get('../escape',value.hash),/namespace/)
  assert.throws(()=>artifacts.create(caller,{title:'Bad',content:'!!!',encoding:'base64'}),/base64/)
  const binary=artifacts.create(caller,{title:'Invalid UTF8',content:'/w==',encoding:'base64',mediaType:'text/plain'})
  assert.deepEqual(artifacts.read(caller,binary.id),{artifact:binary,content:'/w==',encoding:'base64'})
  writeFileSync(join(dir,'blobs',caller.projectId,value.hash.slice(0,2),value.hash),'tampered')
  assert.throws(()=>artifacts.read(caller,value.id),/integrity/)
})
test('Cordis activates independent components from declared dependencies and unwinds provider withdrawal',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'merv-cordis-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const ctx=new Context();t.after(()=>ctx.fiber.dispose())
  const art=ctx.plugin(artifactsPlugin),scope=ctx.plugin(scopePlugin)
  await ctx.plugin(blobsPlugin,{root:join(dir,'blobs')})
  await art;assert.equal(ctx.get('artifacts'),undefined)
  const provider=await ctx.plugin(statePlugin,{path:join(dir,'state.sqlite')})
  await scope.await();await art.await()
  const credentials=ctx.scope.bootstrap({projectName:'Independent',actorName:'User'})
  const caller={actorId:credentials.actor.id,projectId:credentials.project.id}
  const saved=ctx.artifacts.create(caller,{title:'One',content:'survives unload'})
  await provider.dispose();assert.equal(ctx.get('artifacts'),undefined)
  await ctx.plugin(statePlugin,{path:join(dir,'state.sqlite')});await scope.await();await art.await()
  assert.equal(ctx.artifacts.read(caller,saved.id).content,'survives unload')
})
