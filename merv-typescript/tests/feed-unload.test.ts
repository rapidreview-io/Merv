import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runFeedUnloadScenario } from '../scripts/feed-unload-scenario.js'

test('Cordis drains an active feed call, suspends its adapter, and restores it without interrupting a task',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'merv-feed-unload-'))
  try {
    const report=await runFeedUnloadScenario(directory)
    assert.equal(report.status,'passed')
    assert.ok(Object.values(report.checks).every(Boolean))
  } finally {rmSync(directory,{recursive:true,force:true})}
})
