import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const dir=dirname(fileURLToPath(import.meta.url));
const run=join(dir,'run');
const projectId='project_245947d7687247819a19330e3c09e916';
const db=new DatabaseSync(join(run,'server/state.sqlite'),{readOnly:true});
const exported=[];
function artifact(id,file) {
 const a=db.prepare('select id,title,hash,size,media_type,created_at from artifacts where id=? and project_id=?').get(id,projectId);
 if(!a)throw new Error('Artifact not found');
 const bytes=readFileSync(join(run,'server/blobs',projectId,a.hash.slice(0,2),a.hash));
 if(bytes.length!==a.size||createHash('sha256').update(bytes).digest('hex')!==a.hash)throw new Error('Artifact integrity mismatch');
 mkdirSync(dirname(join(dir,file)),{recursive:true});writeFileSync(join(dir,file),bytes);
 exported.push({...a,file});
}
const wave=db.prepare('select id,attempt,review_id,submission from reflections where project_id=? order by rowid desc limit 1').get(projectId);
if(wave?.submission) {
 const submission=JSON.parse(wave.submission);
 artifact(submission.report.id,'reflection-synthesis.md');
 artifact(submission.changeSpec.id,'reflection-changes.md');
 if(submission.paperProposal)artifact(submission.paperProposal.artifact.id,'reflection-paper-proposal.json');
}
if(wave)for(const row of db.prepare('select perspective,producer_id,artifact from reflection_lenses where reflection_id=? and attempt=?').all(wave.id,wave.attempt)) {
 if(row.artifact)artifact(JSON.parse(row.artifact).id,`reflection-lenses/${row.perspective}.md`);
}
const reviews=db.prepare('select id,subject_id,subject_revision,status,verdict,return_to,producer_id,reviewer_id,artifact_ids,synopsis,notes,findings_json from reviews where project_id=? order by created_at').all(projectId).map(row=>{
 const {artifact_ids,findings_json,...rest}=row;return {...rest,artifactIds:JSON.parse(artifact_ids),findings:findings_json?JSON.parse(findings_json):null};
});
writeFileSync(join(dir,'review-history.json'),JSON.stringify(reviews,null,2)+'\n');
const paperFile=join(run,'final-paper.json');
if(existsSync(paperFile)) {
 const paper=JSON.parse(readFileSync(paperFile,'utf8'));
 const lines=['# Ledgerline Flash Lab — current reviewed paper','',`Project: ${projectId}`,''];
 for(const [kind,doc] of Object.entries(paper.documents)) {
  if(!doc.current.sections.some(s=>s.content.trim()))continue;
  lines.push(`## ${kind} (revision ${doc.current.revision})`,'');
  for(const s of doc.current.sections)if(s.content.trim())lines.push(`### ${s.title}`,'',s.content,'');
 }
 writeFileSync(join(dir,'paper.md'),lines.join('\n'));
}
writeFileSync(join(dir,'artifact-index.json'),JSON.stringify({exportedAt:new Date().toISOString(),projectId,reflectionId:wave?.id,reflectionReviewId:wave?.review_id,artifacts:exported},null,2)+'\n');
db.close();
console.log(JSON.stringify({artifacts:exported.length,reviews:reviews.map(r=>({id:r.id,verdict:r.verdict})),paperExported:existsSync(paperFile)}));
