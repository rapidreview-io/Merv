import assert from 'node:assert/strict'
import type { Task, ReviewRequest } from '@merv/contracts'

export const acceptance = {
  title:'Verify arithmetic evidence',
  goal:'Verify the sum and mean of 2, 4, 6, 8.',
  checks:['Sum equals 20','Mean equals 5'],
}

/** Validate the actual model transcript, not its closing claim of success. */
export function verifyLiveEvidence(task:Task,review:ReviewRequest,transcripts:{reviewer:string;observer:string}) {
  assert.equal(task.title,acceptance.title)
  assert.equal(task.goal,acceptance.goal)
  assert.deepEqual(task.checks,acceptance.checks)
  assert.equal(task.workflow.state,'done')
  assert.equal(task.workflow.revision,2)
  assert.equal(review.id,task.reviewId)
  assert.equal(review.subjectId,task.id)
  assert.equal(review.producerId,task.producerId)
  assert.ok(review.reviewerId && review.reviewerId!==task.producerId)
  assert.equal(review.verdict,'pass')
  assert.deepEqual(review.criteria,task.checks)
  assert.deepEqual([...review.artifactIds].sort(),[task.briefId,...task.deliveryIds].sort())
  for(const phase of ['reviewer','observer'] as const) {
    const calls=transcripts[phase].trim().split('\n').map(line=>JSON.parse(line))
      .filter(event=>event.type==='item.completed' && event.item?.type==='mcp_tool_call' && event.item.server==='merv_typescript')
      .map(event=>event.item)
    const successful=(call:any)=>call.status==='completed' && !call.error && !(call.result?.content ?? []).some((part:any)=>{
      if(part.type!=='text')return false
      try{return Boolean(JSON.parse(part.text)?.error)}catch{return false}
    })
    for(const [tool,key,id] of [['task.get','taskId',task.id],['review.get','reviewId',review.id]] as const) {
      assert.ok(calls.some(call=>successful(call) && call.tool===tool && call.arguments?.[key]===id),`${phase} must read the tested ${tool}`)
    }
    const verdictIndex=phase==='reviewer'?calls.findIndex(call=>successful(call) && call.tool==='review.submit' && call.arguments?.reviewId===review.id):calls.length
    assert.ok(verdictIndex>=0,'Reviewer must submit the tested review')
    const requiredArtifacts=phase==='reviewer'?review.artifactIds:task.deliveryIds
    for(const artifactId of requiredArtifacts) {
      assert.ok(calls.slice(0,verdictIndex).some(call=>successful(call) && call.tool==='artifact.read' && call.arguments?.artifactId===artifactId),`${phase} must read pinned artifact ${artifactId} before the verdict`)
    }
  }
  return {expectedTask:true,independentReviewer:true,reviewerReadAllPinnedEvidence:true,observerReadRetainedDelivery:true}
}
