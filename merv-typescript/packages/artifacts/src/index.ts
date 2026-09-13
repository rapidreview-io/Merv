import type { Context } from 'cordis'
import { isUtf8 } from 'node:buffer'
import { check, newId, now, inTransaction, type Artifacts, type Artifact, type ArtifactInput, type Caller, type State, type Scope, type Blobs, type Transaction } from '@merv/contracts'
const fromRow = (row:any):Artifact => ({id:row.id,projectId:row.project_id,createdBy:row.created_by,title:row.title,mediaType:row.media_type,hash:row.hash,size:row.size,createdAt:row.created_at})
export class ArtifactStore implements Artifacts {
  constructor(private state:State,private scope:Scope,private blobs:Blobs) {
    state.migrate('artifacts',[{version:1,sql:`CREATE TABLE artifacts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,created_by TEXT NOT NULL,title TEXT NOT NULL,media_type TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX artifacts_project ON artifacts(project_id);
      CREATE TRIGGER artifacts_immutable_update BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT,'Artifacts are immutable'); END;
      CREATE TRIGGER artifacts_immutable_delete BEFORE DELETE ON artifacts BEGIN SELECT RAISE(ABORT,'Artifacts are immutable'); END;`}])
  }
  create(caller:Caller,input:ArtifactInput,tx?:Transaction):Artifact {
    this.scope.require(caller,'write',tx)
    check(typeof input.title === 'string' && input.title.trim().length > 0 && input.title.length <= 300,'invalid_artifact','Artifact requires a title of at most 300 characters')
    check(typeof input.content === 'string','invalid_artifact','Content must be a string')
    check(input.encoding === undefined || ['utf8','base64'].includes(input.encoding),'invalid_encoding','Encoding must be utf8 or base64')
    if (input.encoding === 'base64') check(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content),'invalid_encoding','Invalid base64 content')
    const mediaType=input.mediaType ?? 'text/markdown'
    check(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mediaType) && mediaType.length <= 150,'invalid_media_type','Invalid media type')
    const bytes=Buffer.from(input.content,input.encoding ?? 'utf8')
    check(bytes.length > 0 && bytes.length <= 2_000_000,'artifact_size','Artifact must contain 1–2,000,000 bytes')
    const stored=this.blobs.put(caller.projectId,bytes)
    return inTransaction(this.state,tx,tx=>{
      this.scope.require(caller,'write',tx)
      const artifact:Artifact={id:newId('art'),projectId:caller.projectId,createdBy:caller.actorId,title:input.title.trim(),mediaType,hash:stored.hash,size:stored.size,createdAt:now()}
      tx.run('INSERT INTO artifacts(id,project_id,created_by,title,media_type,hash,size,created_at) VALUES(?,?,?,?,?,?,?,?)',artifact.id,artifact.projectId,artifact.createdBy,artifact.title,artifact.mediaType,artifact.hash,artifact.size,artifact.createdAt)
      this.state.appendEvent(tx,{projectId:caller.projectId,actorId:caller.actorId,type:'artifact.created',subjectId:artifact.id,data:{hash:artifact.hash,size:artifact.size}})
      return artifact
    })
  }
  get(caller:Caller,artifactId:string,tx?:Transaction):Artifact {
    this.scope.require(caller,'read',tx)
    const row=tx ? tx.get('SELECT * FROM artifacts WHERE id=? AND project_id=?',artifactId,caller.projectId) : this.state.read(sql=>sql.get('SELECT * FROM artifacts WHERE id=? AND project_id=?',artifactId,caller.projectId))
    check(row,'not_found','Artifact not found in this project',404)
    return fromRow(row)
  }
  read(caller:Caller,artifactId:string) {
    const artifact=this.get(caller,artifactId)
    const bytes=this.blobs.get(caller.projectId,artifact.hash)
    const encoding=(artifact.mediaType.startsWith('text/') || artifact.mediaType === 'application/json') && isUtf8(bytes) ? 'utf8' as const : 'base64' as const
    return {artifact,content:bytes.toString(encoding),encoding}
  }
  list(caller:Caller):Artifact[] { this.scope.require(caller,'read'); return this.state.read(sql=>sql.all('SELECT * FROM artifacts WHERE project_id=? ORDER BY created_at,id LIMIT 1000',caller.projectId).map(fromRow)) }
}
export const artifactsPlugin={name:'merv-artifacts',inject:['state','scope','blobs'],apply(ctx:Context){ctx.provide('artifacts',new ArtifactStore(ctx.state,ctx.scope,ctx.blobs))}}
export default artifactsPlugin
