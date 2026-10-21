#!/usr/bin/env node
/** Read-only operator evidence. No service initialization, migrations, or provider calls.
 * node deploy/hosted-native-observe.mjs --host ResearchSuite_Control --project project_ID [--instance wf_ID]
 * Without --instance, returns project preflight metadata only. Repeat externally for a timeline.
 * Main and Sandboxes are separate read-only snapshots; timestamps do not imply atomicity.
 */
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export function validateInput({ host, projectId, instanceId }) {
  if (typeof host !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,199}$/.test(host))
    throw new Error('An explicit safe SSH host is required');
  if (typeof projectId !== 'string' || !/^project_[A-Za-z0-9_-]{1,180}$/.test(projectId))
    throw new Error('An explicit project ID is required');
  if (
    instanceId !== undefined &&
    (typeof instanceId !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,199}$/.test(instanceId))
  )
    throw new Error('Invalid workflow instance ID');
  return { host, projectId, ...(instanceId === undefined ? {} : { instanceId }) };
}

/** Docker uses init:true. Read only Main (PID 1 or init's direct child), never other processes. */
export function mainEnvironment(readFile, names) {
  if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
    throw new Error('Invalid environment selector');
  const children = readFile('/proc/1/task/1/children', 'utf8').trim().split(/\s+/).filter(Boolean);
  if (children.length > 32 || children.some((pid) => !/^\d+$/.test(pid)))
    throw new Error('Unknown process tree');
  const matches = ['1', ...children].filter((pid) => {
    let args;
    try {
      args = readFile(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    } catch {
      return false;
    }
    const script = args.indexOf('/app/dist/src/cli.js');
    return (
      /(^|\/)node$/.test(args[0]) &&
      script > 0 &&
      args[script + 1] === 'serve' &&
      args[args.indexOf('--config') + 1] === '/tmp/merv-config.json'
    );
  });
  if (matches.length !== 1) throw new Error('Cannot identify the running Main process');
  const selected = {};
  for (const item of readFile(`/proc/${matches[0]}/environ`, 'utf8').split('\0')) {
    const split = item.indexOf('=');
    const name = item.slice(0, split);
    if (split > 0 && names.includes(name)) selected[name] = item.slice(split + 1);
  }
  return { pid: matches[0], selected };
}

// This function is also sent through stdin to Main's Node process. Keep it self-contained.
export async function readSnapshot(client, schema, input, kind) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid database schema');
  const truncated = [];
  const rows = async (name, sql, params = [], limit = 100) => {
    const result = await client.query(sql, params);
    if (result.rows.length > limit) truncated.push(name);
    return result.rows.slice(0, limit);
  };
  const q = async (sql, params = []) => (await client.query(sql, params)).rows;
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query(`SET LOCAL search_path = "${schema}"`);
    await client.query("SET LOCAL statement_timeout = '10000ms'");
    const clock = (
      await q("SELECT now() AS observed_at, current_setting('transaction_read_only') AS read_only")
    )[0];
    if (clock.read_only !== 'on') throw new Error('Read-only transaction required');
    if (kind === 'sandboxes') {
      const ids = input.sandboxIds;
      const sandboxes = await rows(
        'sandboxes',
        `SELECT id,namespace,provider,native_id,state,revision,
        created_at,updated_at,ready_at,stopped_at,presence_checked_at,lease_expires_at,agent_seen_at
        FROM sandboxes WHERE id=ANY($1::text[]) ORDER BY id LIMIT 101`,
        [ids],
      );
      const launches = await rows(
        'launches',
        `SELECT namespace,launch_id,sandbox_id,release_id,job_id,state,
        delivery_state,created_at,expires_at FROM runtime_bootstraps
        WHERE sandbox_id=ANY($1::text[]) AND launch_id=ANY($2::text[]) ORDER BY created_at,launch_id LIMIT 101`,
        [ids, input.launchIds],
      );
      const deletionEvents = await rows(
        'deletionEvents',
        `SELECT seq,id,sandbox_id,kind,at FROM sandbox_events
        WHERE sandbox_id=ANY($1::text[]) AND kind IN ('sandbox.delete_requested','sandbox.stopped')
        ORDER BY seq LIMIT 201`,
        [ids],
        200,
      );
      const deleteWork = await rows(
        'deleteWork',
        `SELECT id,kind,sandbox_id,state,attempts,max_attempts,
        run_after,created_at,updated_at FROM work_items WHERE sandbox_id=ANY($1::text[]) AND kind='delete'
        ORDER BY created_at,id LIMIT 101`,
        [ids],
      );
      return { ...clock, sandboxes, launches, deletionEvents, deleteWork, truncated };
    }
    const p = [input.projectId];
    if (!(await q('SELECT id FROM projects WHERE id=$1', p)).length)
      throw new Error('Project not found');
    const activity = (
      await q(
        `SELECT
      (SELECT count(*) FROM worker_sessions WHERE project_id=$1 AND status IN ('offered','active')) AS active_sessions,
      (SELECT count(*) FROM fleet_allocations WHERE project_id=$1 AND phase<>'released') AS open_allocations,
      (SELECT count(*) FROM wf_instances i JOIN wf_definitions d ON d.name=i.workflow AND d.version=i.version
        WHERE i.project_id=$1 AND NOT jsonb_exists(d.definition_json::jsonb->'terminal',i.state)) AS unfinished_workflows,
      (SELECT count(*) FROM code_operations WHERE project_id=$1 AND status NOT IN ('completed','failed')
        AND kind<>'mirror-accepted') AS unfinished_code_operations,
      (SELECT count(*) FROM code_commands WHERE project_id=$1 AND status IN ('queued','dispatched')) AS unfinished_code_commands`,
        p,
      )
    )[0];
    // Retired by 058c57222: these retained publication journals are never run or retried.
    // Exclude exactly this kind from live ownership; report it without changing its status.
    const retired =
      "project_id=$1 AND kind='mirror-accepted' AND status NOT IN ('completed','failed')";
    const retainedLegacyMirrors = {
      count: (await q(`SELECT count(*) AS count FROM code_operations WHERE ${retired}`, p))[0]
        .count,
      operations: await rows(
        'retainedLegacyMirrors',
        `SELECT id,kind,status,phase,created_at,unit_id,generation FROM code_operations
          WHERE ${retired} ORDER BY created_at,id LIMIT 101`,
        p,
      ),
    };
    const dispatch = await q(
      'SELECT enabled,own_machines,updated_at FROM project_session_dispatch WHERE project_id=$1',
      p,
    );
    const budgets = await rows(
      'budgets',
      `SELECT scope_id,max_wall_ms,max_cost_micros,max_tokens,updated_at
      FROM session_budgets WHERE project_id=$1 AND (scope_id=$1 OR scope_id=$2) ORDER BY scope_id LIMIT 101`,
      [input.projectId, input.instanceId ?? null],
    );
    const ledger = (await q("SELECT to_regclass('wf_protocol_migrations') AS name"))[0].name;
    const migration = ledger
      ? (
          await q(
            `SELECT count(*) AS workflows, min(created_at) AS first_at,
      max(created_at) AS last_at FROM wf_protocol_migrations WHERE project_id=$1`,
            p,
          )
        )[0]
      : null;
    const base = {
      ...clock,
      projectId: input.projectId,
      activity,
      retainedLegacyMirrors,
      dispatch,
      budgets,
      migration,
    };
    if (!input.instanceId) return { ...base, truncated };
    const params = [input.projectId, input.instanceId];
    const workflow = (
      await q(
        `SELECT id,workflow,version,state,revision,created_at,updated_at
      FROM wf_instances WHERE project_id=$1 AND id=$2`,
        params,
      )
    )[0];
    if (!workflow) throw new Error('Workflow not found in project');
    const sessions = await rows(
      'sessions',
      `SELECT s.id,s.actor_id,s.revision,s.status,s.runner_id,s.thread_id,
      s.session_json::jsonb->>'hostRef' AS host_ref,
      s.session_json::jsonb->>'role' AS role,s.session_json::jsonb->>'kind' AS kind,
      s.session_json::jsonb->>'createdAt' AS created_at,s.session_json::jsonb->>'activatedAt' AS activated_at,
      s.session_json::jsonb->>'closedAt' AS closed_at,s.session_json::jsonb->>'outcome' AS outcome,
      w.attachment_json::jsonb->>'headOid' AS attached_head,w.attachment_json::jsonb->>'treeOid' AS attached_tree,
      w.attachment_json::jsonb#>>'{submission,sessionId}' AS submission_session_id,
      w.attachment_json::jsonb#>>'{submission,parentOid}' AS submission_parent,
      w.attachment_json::jsonb#>>'{submission,treeOid}' AS submission_tree,
      w.result_json::jsonb->>'headOid' AS result_head,w.result_json::jsonb->>'treeOid' AS result_tree
      FROM worker_sessions s LEFT JOIN session_workspaces w ON w.session_id=s.id
      WHERE s.project_id=$1 AND s.instance_id=$2 ORDER BY s.revision,s.id LIMIT 101`,
      params,
    );
    const assignments = await rows(
      'assignments',
      `SELECT a.session_id,a.allocation_id,a.runner_id,
      a.bound_at,a.release_ack_at,a.settled_at FROM session_managed_assignments a
      JOIN worker_sessions s ON s.id=a.session_id WHERE s.project_id=$1 AND s.instance_id=$2
      ORDER BY a.ordinal LIMIT 101`,
      params,
    );
    const allocations = await rows(
      'allocations',
      `SELECT id,phase,created_at,
      data_json::jsonb->>'epoch' AS epoch,data_json::jsonb#>>'{owner,kind}' AS owner_kind,
      data_json::jsonb#>>'{owner,id}' AS owner_id,data_json::jsonb->>'profileId' AS profile_id,
      data_json::jsonb->>'intent' AS intent,data_json::jsonb->>'updatedAt' AS updated_at,
      data_json::jsonb->>'shutdownRequired' AS shutdown_required,
      data_json::jsonb->>'shutdownAcknowledged' AS shutdown_acknowledged,
      data_json::jsonb->>'deadlineAt' AS deadline_at,data_json::jsonb->>'releaseBy' AS release_by,
      data_json::jsonb->>'retryAt' AS retry_at,data_json::jsonb->>'failures' AS failures,
      data_json::jsonb#>>'{runtime,sandboxId}' AS sandbox_id,
      data_json::jsonb#>>'{runtime,state}' AS runtime_state,
      data_json::jsonb#>>'{runtime,launch,launchId}' AS launch_id,
      data_json::jsonb#>>'{runtime,launch,jobId}' AS job_id
      FROM fleet_allocations WHERE project_id=$1 AND
      ((data_json::jsonb#>>'{owner,kind}'='workflow' AND data_json::jsonb#>>'{owner,id}'=$2)
        OR id=ANY($3::text[])) ORDER BY created_at,id LIMIT 101`,
      [input.projectId, `work:${input.instanceId}`, assignments.map((a) => a.allocation_id)],
    );
    const ids = [allocations.map((a) => a.id)];
    const runners = await rows(
      'runners',
      `SELECT allocation_id,epoch,runtime_profile_id,work_instance_id,
      runner_id,created_at,runner_released_at,
      platform_json::jsonb->>'name' AS platform,platform_json::jsonb->>'harness' AS harness,
      platform_json::jsonb->>'model' AS model,platform_json::jsonb->>'effort' AS effort
      FROM session_managed_runners WHERE allocation_id=ANY($1::text[]) ORDER BY created_at,allocation_id LIMIT 101`,
      ids,
    );
    // Receipt schema contains only immutable IDs and object hashes; still project each field explicitly.
    const shutdowns = await rows(
      'shutdowns',
      `SELECT allocation_id,epoch,requested_at,acknowledged_at,
      receipt_json::jsonb->>'empty' AS empty,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('sessionId',c->>'sessionId','unitId',c->>'unitId',
        'operationId',c->>'operationId','headOid',c->>'headOid','treeOid',c->>'treeOid')),'[]'::jsonb)
        FROM jsonb_array_elements(receipt_json::jsonb->'captures') c) AS captures
      FROM session_managed_shutdowns WHERE allocation_id=ANY($1::text[]) ORDER BY requested_at,allocation_id LIMIT 101`,
      ids,
    );
    const workspace = await q(
      `SELECT unit_id,generation,writer_state,writer_session_id,writer_changed_at,
      head_oid,head_operation_id,final_owed,blocked_by,quarantine_operation_id
      FROM code_workspaces WHERE project_id=$1 AND unit_id=$2`,
      params,
    );
    const operations = await rows(
      'operations',
      `SELECT id,kind,status,unit_id,generation,created_at,completed_at,phase,
      payload_json::jsonb->>'kind' AS capture_kind,payload_json::jsonb->>'sessionId' AS session_id,
      payload_json::jsonb->>'expectedHead' AS expected_head,payload_json::jsonb->>'proposedHead' AS proposed_head,
      result_json::jsonb->>'head' AS head_oid,result_json::jsonb->>'tree' AS tree_oid
      FROM code_operations WHERE project_id=$1 AND unit_id=$2 ORDER BY created_at,id LIMIT 201`,
      params,
      200,
    );
    const allocationEvents = await rows(
      'allocationEvents',
      `SELECT id,type,subject_id,created_at,
      data_json::jsonb->>'phase' AS phase,data_json::jsonb->>'intent' AS intent
      FROM events WHERE project_id=$1 AND subject_id=ANY($2::text[]) AND type IN ('fleet.changed','fleet.requested')
      ORDER BY id LIMIT 201`,
      [input.projectId, ids[0]],
      200,
    );
    return {
      ...base,
      workflow,
      sessions,
      assignments,
      allocations,
      runners,
      shutdowns,
      workspace,
      operations,
      allocationEvents,
      truncated,
    };
  } finally {
    await client.query('ROLLBACK');
  }
}

export function remoteProgram(input) {
  input = validateInput(input);
  return `import pg from 'pg';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const readSnapshot=${readSnapshot.toString()};
const mainEnvironment=${mainEnvironment.toString()};
const input=${JSON.stringify(input)};
let stage='configuration';
try {
  const config=JSON.parse(readFileSync('/tmp/merv-config.json','utf8'));
  const plugin=id=>config.plugins.find(p=>p.id===id)?.config;
  const fleet=plugin('fleet'), workflow=plugin('fleet-workflow'), sandboxes=plugin('sandboxes-host');
  const runtime=mainEnvironment(readFileSync,['MERV_DB_URL','MERV_TS_DB_SCHEMA','MERV_BOOT_MAINTENANCE',
    ...(workflow?[workflow.modelApiKeyEnv]:[]),...(sandboxes?[sandboxes.databaseUrlEnv]:[])]);
  const env=runtime.selected;
  stage='health';
  const response=await fetch('http://127.0.0.1:3081/health',{signal:AbortSignal.timeout(5000)});
  const health=await response.json();
  if(!response.ok||health.status!=='ok'||(health.maintenance!==undefined&&typeof health.maintenance!=='boolean'))
    throw new Error('Runtime health is unknown');
  if(![undefined,'0','1'].includes(env.MERV_BOOT_MAINTENANCE)||
    (health.maintenance===true)!==(env.MERV_BOOT_MAINTENANCE==='1'))
    throw new Error('Runtime maintenance evidence disagrees');
  const profiles=(fleet?.profiles??[]).map(p=>({key:p.key,provider:p.provider,offerId:p.offerId,
    releaseId:p.releaseId,leaseSeconds:p.leaseSeconds,ttlSeconds:p.ttlSeconds??300,
    profileId:'srp_'+createHash('sha256').update(JSON.stringify([p.provider,p.offerId,p.releaseId,p.leaseSeconds,p.ttlSeconds??300])).digest('hex')}));
  const settings={maintenance:health.maintenance===true,maintenanceSource:'live-health',runtimePid:runtime.pid,profiles,
    fleet:fleet?{globalLimit:fleet.globalLimit??50,projectLimit:fleet.projectLimits?.[input.projectId]??fleet.projectLimit??5}:null,
    workflow:workflow?{maxAgents:workflow.maxAgents??10,dailyTokensPerPerson:workflow.dailyTokensPerPerson??20000000,
      astraMediumEnabled:workflow.astraMediumEnabled??false,modelKeyConfigured:null,
      bootModelKeyPresent:!!env[workflow.modelApiKeyEnv],
      modelKeyEvidence:'Initial Main process environment only; stored-secret overrides are not inspected.',
      allPeople:workflow.people?.includes('*')??false,peopleCount:workflow.people?.length??0}:null};
  async function read(connectionString,schema,args,kind) {
    if(!connectionString) throw new Error('Database unavailable');
    const client=new pg.Client({connectionString,connectionTimeoutMillis:10000});
    try {await client.connect();return await readSnapshot(client,schema,args,kind);}
    finally {await client.end();}
  }
  stage='main';
  const main=await read(env.MERV_DB_URL,env.MERV_TS_DB_SCHEMA??'merv_ts',input,'main');
  let registry=null;
  if(input.instanceId&&main.allocations.length) {
    stage='sandboxes';
    if(!sandboxes) throw new Error('Sandboxes configuration unavailable');
    registry=await read(env[sandboxes.databaseUrlEnv],sandboxes.schema??'public',{
      sandboxIds:main.allocations.map(a=>a.sandbox_id).filter(Boolean),
      launchIds:main.allocations.map(a=>a.launch_id).filter(Boolean)},'sandboxes');
  }
  console.log(JSON.stringify({settings,main,registry}));
} catch {console.log(JSON.stringify({error:'observer_failed',stage}));process.exitCode=1;}
`;
}

function ssh(host, command, stdin = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', host, command],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '',
      failed = false;
    const stop = () => {
      failed = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(stop, 60_000);
    child.stdout.on('data', (data) => {
      output += data;
      if (output.length > 2_000_000) stop();
    });
    child.stderr.resume(); // SSH/PG diagnostics may contain private configuration; never relay them.
    child.stdin.on('error', () => {});
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Observer SSH process failed'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failed || code !== 0)
        return reject(new Error('Observer SSH/read failed; no snapshot accepted'));
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new Error('Invalid observer response'));
      }
    });
    child.stdin.end(stdin);
  });
}

export async function observe(options) {
  const input = validateInput(options);
  const startedAt = new Date().toISOString();
  const inspect = `sudo -n docker inspect --format '{"id":{{json .Id}},"imageId":{{json .Image}},"image":{{json .Config.Image}},"startedAt":{{json .State.StartedAt}},"status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"nativeGitProtocol":{{json (index .Config.Labels "org.merv.native-git-protocol")}}}' merv-typescript-control-1`;
  const before = await ssh(input.host, inspect);
  const data = await ssh(
    input.host,
    'sudo -n docker exec -i -w /app merv-typescript-control-1 node --input-type=module -',
    remoteProgram(input),
  );
  const after = await ssh(input.host, inspect);
  if (
    before.id !== after.id ||
    before.startedAt !== after.startedAt ||
    before.imageId !== after.imageId
  )
    throw new Error('Main changed during observation; retry');
  const truncated = [...data.main.truncated, ...(data.registry?.truncated ?? [])];
  return {
    format: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    ...input,
    mainContainer: after,
    ...data,
    complete: truncated.length === 0,
    limits: [
      'Main and Sandboxes snapshots are separate transactions.',
      'Provider deletion is registry evidence, not a direct provider API observation.',
      'This metadata does not prove worktree bytes, Git object availability, or lost-response retry.',
      'Configured model availability is not an account-specific model grant; sessions show actual granted platforms.',
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: {
        host: { type: 'string' },
        project: { type: 'string' },
        instance: { type: 'string' },
      },
    });
    console.log(
      JSON.stringify(
        await observe({
          host: values.host,
          projectId: values.project,
          instanceId: values.instance,
        }),
      ),
    );
  } catch {
    console.error(
      'Observer refused or could not verify a complete read-only snapshot; check explicit --host/--project/--instance and operator access.',
    );
    process.exitCode = 1;
  }
}
