import { z } from 'zod';
import { check, digest } from '@merv/contracts';
import type {
  Sql,
  WorkflowAssignmentContent,
  WorkflowAssignmentRule,
  WorkflowCheckContext,
  WorkflowWorkStart,
} from '@merv/contracts';
import { toolName } from './definition.js';
import { workflowJson } from './json.js';

const text = z.string().min(1);
const tool = z.string().regex(toolName);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const reference = z.object({ kind: text, id: text, label: text }).strict();
/**
 * The context package is context-builder's: the engine checks only what it fences (whose it is,
 * which revision it renders, and its content hash) and keeps every other field as built.
 * Context Builder resolved each source through Artifacts for this caller, so sources need no
 * check here. A field the package gains never refuses the packet.
 */
const preview = z
  .object({
    projectId: text,
    actorId: text,
    subject: z.object({ id: text, revision: z.number().int().nonnegative().safe() }).passthrough(),
    hash,
  })
  .passthrough();
const content = z
  .object({
    role: text,
    label: text,
    name: text.optional(),
    brief: text,
    references: z.array(reference),
    handoff: z.object({ instruction: text, tools: z.array(tool) }).strict(),
    execution: z
      .object({
        readOnly: z.boolean(),
        tools: z.array(z.object({ name: tool, arguments: z.record(z.unknown()) }).strict()),
      })
      .strict(),
    context: preview.nullable(),
  })
  .strict();

/** Validate the provider boundary and detach nested data before returning a packet. */
export async function buildAssignment(
  rule: WorkflowAssignmentRule,
  context: WorkflowCheckContext,
): Promise<WorkflowAssignmentContent> {
  const detached = workflowJson(await rule.build(context));
  const parsed = content.safeParse(detached);
  check(parsed.success, 'invalid_workflow_policy', 'Invalid workflow assignment packet', 500);
  const result = parsed.data;
  if (result.context) {
    const { hash: packetHash, ...body } = result.context;
    check(
      body.projectId === context.caller.projectId &&
        body.actorId === context.caller.actorId &&
        body.subject.id === context.snapshot.id &&
        body.subject.revision === context.snapshot.revision &&
        digest(body) === packetHash,
      'invalid_workflow_policy',
      'Assignment context must match the current actor, project, revision and content hash',
      500,
    );
  }
  return result as WorkflowAssignmentContent;
}

interface WorkStartRow {
  instance_id: string;
  project_id: string;
  workflow: string;
  version: number;
  state: string;
  revision: number;
  actor_id: string;
  started_at: string;
  event_id: number;
}

const workStart = (row: WorkStartRow): WorkflowWorkStart => ({
  instanceId: row.instance_id,
  projectId: row.project_id,
  workflow: row.workflow,
  version: row.version,
  state: row.state,
  revision: row.revision,
  actorId: row.actor_id,
  startedAt: row.started_at,
  eventId: row.event_id,
});

/** Every start of one instance, in revision order. */
/** Each instance's starts in revision order, in one read however many; none is []. */
export async function readWorkStarts(
  sql: Sql,
  projectId: string,
  instanceIds: readonly string[],
): Promise<Map<string, WorkflowWorkStart[]>> {
  const found = new Map(instanceIds.map((id) => [id, [] as WorkflowWorkStart[]]));
  if (!found.size) return found;
  for (const row of await sql.all<WorkStartRow>(
    `SELECT * FROM wf_work_starts WHERE project_id=? AND instance_id IN (${[...found.keys()].map(() => '?').join(',')}) ORDER BY revision`,
    projectId,
    ...found.keys(),
  ))
    found.get(row.instance_id)!.push(workStart(row));
  return found;
}

/** The start at each instance's revision, where there is one, in one read however many. */
export async function workStartsAt(
  sql: Sql,
  projectId: string,
  instances: readonly { id: string; revision: number }[],
): Promise<Map<string, WorkflowWorkStart>> {
  if (!instances.length) return new Map();
  const rows = await sql.all<WorkStartRow>(
    `SELECT * FROM wf_work_starts WHERE project_id=? AND (instance_id,revision) IN (${instances.map(() => '(?,?)').join(',')})`,
    projectId,
    ...instances.flatMap(({ id, revision }) => [id, revision]),
  );
  return new Map(rows.map((row) => [row.instance_id, workStart(row)]));
}
