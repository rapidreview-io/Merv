import { mkdirSync,writeFileSync } from 'node:fs'
import { dirname,join,resolve } from 'node:path'
import { runFeedUnloadScenario } from './feed-unload-scenario.js'

const directory=resolve(process.argv[2] ?? join('live-runs',`feed-unload-${new Date().toISOString().replaceAll(':','-')}`))
mkdirSync(dirname(directory),{recursive:true})
mkdirSync(directory,{mode:0o700})
try {
  const report=await runFeedUnloadScenario(join(directory,'data'),item=>console.log(JSON.stringify(item)))
  const path=join(directory,'report.json')
  writeFileSync(path,JSON.stringify({...report,completedAt:new Date().toISOString()},null,2)+'\n')
  console.log(JSON.stringify({status:'passed',report:path}))
} catch(error) {
  writeFileSync(join(directory,'failure.json'),JSON.stringify({status:'failed',message:error instanceof Error?error.message:String(error)},null,2)+'\n')
  console.error(error);process.exitCode=1
}
