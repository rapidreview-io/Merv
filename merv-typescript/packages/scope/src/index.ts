import { createHash, randomBytes } from 'node:crypto'
import type { Context } from 'cordis'
import { check, newId, now, inTransaction, type State, type Scope, type Caller, type Role, type Permission, type Actor, type Project, type Transaction } from '@merv/contracts'

const hashToken = (token:string) => createHash('sha256').update(token).digest('hex')
const actor = (row:any):Actor => ({id:row.id,projectId:row.project_id,name:row.name,role:row.role,active:!!row.active})
const project = (row:any):Project => ({id:row.id,name:row.name,createdAt:row.created_at})
const roles = ['operator','producer','reviewer','reader']
export class ProjectScope implements Scope {
  constructor(private state: State) {
    state.migrate('scope',[{version:1,sql:`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE actors(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('operator','producer','reviewer','reader')),token_hash TEXT NOT NULL UNIQUE,active INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX actors_project ON actors(project_id);`}])
  }
  private issue(tx:Transaction,projectId:string,name:string,role:Role) {
    check(typeof name === 'string' && name.trim().length > 0 && name.length <= 200,'invalid_actor','Actor needs a name of at most 200 characters')
    check(roles.includes(role),'invalid_role','Unknown actor role')
    const token = randomBytes(32).toString('base64url')
    const value:Actor = {id:newId('actor'),projectId,name:name.trim(),role,active:true}
    tx.run('INSERT INTO actors(id,project_id,name,role,token_hash,active) VALUES(?,?,?,?,?,1)',value.id,projectId,value.name,role,hashToken(token))
    return {actor:value,token}
  }
  bootstrap(input:{projectName:string;actorName:string}) {
    check(typeof input.projectName === 'string' && input.projectName.trim().length > 0 && input.projectName.length <= 200,'invalid_project','Project needs a name of at most 200 characters')
    return this.state.transaction(tx => {
      const value:Project = {id:newId('project'),name:input.projectName.trim(),createdAt:now()}
      tx.run('INSERT INTO projects(id,name,created_at) VALUES(?,?,?)',value.id,value.name,value.createdAt)
      const credential = this.issue(tx,value.id,input.actorName,'operator')
      this.state.appendEvent(tx,{projectId:value.id,actorId:credential.actor.id,type:'project.created',subjectId:value.id,data:{name:value.name}})
      return {project:value,...credential}
    })
  }
  authenticate(token:string):Actor {
    check(typeof token === 'string' && token.length >= 32 && token.length <= 200,'unauthorized','Invalid bearer credential',401)
    const row = this.state.read(sql => sql.get('SELECT * FROM actors WHERE token_hash=? AND active=1',hashToken(token)))
    check(row,'unauthorized','Invalid or revoked bearer credential',401)
    return actor(row)
  }
  require(caller:Caller,permission:Permission,tx?:Transaction):Actor {
    if (tx) this.state.assertTransaction(tx)
    const row = tx ? tx.get('SELECT * FROM actors WHERE id=? AND project_id=? AND active=1',caller.actorId,caller.projectId) : this.state.read(sql=>sql.get('SELECT * FROM actors WHERE id=? AND project_id=? AND active=1',caller.actorId,caller.projectId))
    check(row,'forbidden','Actor cannot access this project',403)
    const value = actor(row)
    const allowed = permission === 'read' || value.role === 'operator' || (permission === 'write' && value.role === 'producer') || (permission === 'review' && value.role === 'reviewer')
    check(allowed,'forbidden',`Actor lacks ${permission} permission`,403)
    return value
  }
  project(caller:Caller):Project { this.require(caller,'read'); return this.state.read(sql=>project(sql.get('SELECT * FROM projects WHERE id=?',caller.projectId))) }
  issueActor(caller:Caller,input:{name:string;role:Role}) {
    return this.state.transaction(tx=> {
      this.require(caller,'admin',tx)
      const result = this.issue(tx,caller.projectId,input.name,input.role)
      this.state.appendEvent(tx,{projectId:caller.projectId,actorId:caller.actorId,type:'actor.created',subjectId:result.actor.id,data:{name:result.actor.name,role:result.actor.role}})
      return result
    })
  }
  actors(caller:Caller) { this.require(caller,'admin'); return this.state.read(sql=>sql.all('SELECT * FROM actors WHERE project_id=? ORDER BY id',caller.projectId).map(actor)) }
  revokeActor(caller:Caller,actorId:string):void {
    this.state.transaction(tx=>{ this.require(caller,'admin',tx); check(actorId !== caller.actorId,'self_revoke','Cannot revoke your own operator credential'); const r=tx.run('UPDATE actors SET active=0 WHERE id=? AND project_id=?',actorId,caller.projectId); check(r.changes,'not_found','Actor not found',404); this.state.appendEvent(tx,{projectId:caller.projectId,actorId:caller.actorId,type:'actor.revoked',subjectId:actorId,data:{}}) })
  }
}
export const scopePlugin = {name:'merv-scope',inject:['state'],apply(ctx:Context) {ctx.provide('scope',new ProjectScope(ctx.state))}}
export default scopePlugin
