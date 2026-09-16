import { z } from 'zod';
import { check, digest, MervError } from '@merv/contracts';
import type {
  Sql,
  WorkflowAssignmentContent,
  WorkflowAssignmentRule,
  WorkflowCheckContext,
  WorkflowWorkStart,
} from '@merv/contracts';
import { canonical } from './definition.js';

const text = z.string().min(1);
const identifier = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/);
const tool = z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const reference = z.object({ kind: text, id: text, label: text }).strict();
const preview = z
  .object({
    projectId: text,
    actorId: text,
    type: identifier,
    typeVersion: z.number().int().positive().safe(),
    recipeHash: hash,
    subject: z
      .object({
        id: text,
        revision: z.number().int().nonnegative().safe(),
        claimId: text.optional(),
      })
      .strict(),
    prompt: text,
    sources: z.array(
      z
        .object({
          id: text,
          projectId: text,
          createdBy: text,
          title: text,
          mediaType: text,
          hash,
          size: z.number().int().nonnegative().safe(),
          createdAt: text,
        })
        .strict(),
    ),
    omitted: z.array(text),
    hash,
  })
  .strict();
const content = z
  .object({
    role: text,
    label: text,
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
  const value = await rule.build(context);
  let detached: unknown;
  try {
    detached = JSON.parse(canonical(value));
  } catch {
    throw new MervError(
      'invalid_workflow_policy',
      'Workflow assignments must contain only finite JSON values',
      500,
    );
  }
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
        body.sources.every((source) => source.projectId === context.caller.projectId) &&
        digest(body) === packetHash,
      'invalid_workflow_policy',
      'Assignment context must match the current actor, project, revision and content hash',
      500,
    );
  }
  // canonical() already verified that unknown tool arguments are finite JSON.
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

export async function readWorkStarts(
  sql: Sql,
  projectId: string,
  instanceId: string,
  revision?: number,
): Promise<WorkflowWorkStart[]> {
  return (
    await sql.all<WorkStartRow>(
      `SELECT * FROM wf_work_starts WHERE project_id=? AND instance_id=?${revision === undefined ? '' : ' AND revision=?'} ORDER BY revision`,
      projectId,
      instanceId,
      ...(revision === undefined ? [] : [revision]),
    )
  ).map((row) => ({
    instanceId: row.instance_id,
    projectId: row.project_id,
    workflow: row.workflow,
    version: row.version,
    state: row.state,
    revision: row.revision,
    actorId: row.actor_id,
    startedAt: row.started_at,
    eventId: row.event_id,
  }));
}
