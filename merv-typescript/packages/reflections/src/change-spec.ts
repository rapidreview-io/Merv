import { z } from 'zod';
import { check, folded, idSchema, ordered, parsed, visible } from '@merv/contracts';
import type { ChangeSpec } from './types.js';

/**
 * The plan rides in the submission, the approval, every reflection.get and the reviewer's
 * bounded context, so its limits are set by what a reviewer can read, not by what storage holds.
 */
export const CHANGE_SPEC_LIMITS = {
  bytes: 64_000,
  items: 12,
  experiments: 7,
  carriedOver: 20,
  rejected: 20,
} as const;

const line = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(visible)
    .refine((value) => value === value.trim() && !/[\r\n]/.test(value), 'Use one trimmed line');
const text = (max: number) => z.string().min(1).max(max).refine(visible);
const reason = text(1000);
const key = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const workflowId = idSchema;
const dependsOn = z.array(key).max(CHANGE_SPEC_LIMITS.items);

const task = z
  .object({
    key,
    kind: z.literal('task'),
    title: line(200),
    // With the Why and Origin lines the next wave appends, this stays inside task.create's cap.
    goal: text(4000),
    checks: z.array(line(500)).min(1).max(12),
    dependsOn,
    rationale: reason,
  })
  .strict();
const experiment = z
  .object({
    key,
    kind: z.literal('experiment'),
    // Reflections cannot import Experiments, so its naming rule is repeated here. If the two
    // drift, the next wave refuses the name when it creates the experiment; nothing passes silently.
    name: z
      .string()
      .min(3)
      .max(48)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    question: text(4000),
    details: z.string().max(4000),
    dependsOn,
    rationale: reason,
  })
  .strict();
const workspace = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('none') }).strict(),
  z.object({ provider: z.literal('code'), version: z.literal(1) }).strict(),
]);
const changeSpecSchema = z
  .object({
    version: z.literal(2),
    changes: text(8000),
    next: z.discriminatedUnion('decision', [
      z.object({ decision: z.literal('continue'), name: line(200), rationale: reason }).strict(),
      z
        .object({
          decision: z.literal('stop'),
          reason: z.enum(['goal_met', 'no_worthwhile_next_step', 'needs_owner']),
          rationale: reason,
        })
        .strict(),
    ]),
    items: z
      .array(
        z.discriminatedUnion('kind', [
          task.extend({ workspace }),
          experiment.extend({ workspace }),
        ]),
      )
      .max(CHANGE_SPEC_LIMITS.items),
    carriedOver: z
      .array(z.object({ workflowId, reason }).strict())
      .max(CHANGE_SPEC_LIMITS.carriedOver),
    rejected: z
      .array(z.object({ title: line(200), reason }).strict())
      .max(CHANGE_SPEC_LIMITS.rejected),
  })
  .strict();

// Two checks are the same one by folded(), which Tasks uses too. A pair Tasks would refuse is
// refused while the author can still reword it, not after the plan is approved and can only be
// skipped.

const refuse: (condition: unknown, message: string) => asserts condition = (condition, message) =>
  check(condition, 'invalid_change_spec', message);

/**
 * A JSON change specification as the plan it states. Only what the document alone can show is
 * judged here; whether its names still fit the project is judged when the work is created.
 */
export function parseChangeSpec(content: string): ChangeSpec {
  refuse(
    Buffer.byteLength(content) <= CHANGE_SPEC_LIMITS.bytes,
    `A JSON change specification is at most ${CHANGE_SPEC_LIMITS.bytes} bytes`,
  );
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    refuse(false, 'An application/json change specification must be valid JSON');
  }
  const spec = parsed(changeSpecSchema, json, 'invalid_change_spec');
  const kinds = new Map<string, 'task' | 'experiment'>();
  for (const item of spec.items) {
    refuse(!kinds.has(item.key), `Item key ${item.key} occurs more than once`);
    kinds.set(item.key, item.kind);
  }
  const names = new Set<string>();
  for (const item of spec.items) {
    if (item.kind === 'experiment') {
      const name = item.name.toLowerCase();
      refuse(!names.has(name), `Experiment name ${item.name} occurs more than once`);
      names.add(name);
    } else
      refuse(
        new Set(item.checks.map(folded)).size === item.checks.length,
        `Item ${item.key} repeats a check`,
      );
    refuse(
      new Set(item.dependsOn).size === item.dependsOn.length,
      `Item ${item.key} repeats a dependency`,
    );
    for (const dependency of item.dependsOn) {
      refuse(dependency !== item.key, `Item ${item.key} depends on itself`);
      refuse(kinds.has(dependency), `Item ${item.key} depends on unknown key ${dependency}`);
      refuse(
        item.kind === 'task' || kinds.get(dependency) === 'task',
        `Experiment ${item.key} may depend only on tasks, and ${dependency} is an experiment`,
      );
    }
  }
  refuse(
    names.size <= CHANGE_SPEC_LIMITS.experiments,
    `A plan holds at most ${CHANGE_SPEC_LIMITS.experiments} experiments`,
  );
  refuse(ordered(spec.items), 'Item dependencies form a cycle');
  const carried = spec.carriedOver.map((entry) => entry.workflowId);
  refuse(new Set(carried).size === carried.length, 'carriedOver names a workflow more than once');
  if (spec.next.decision === 'stop')
    refuse(
      spec.items.length === 0 && carried.length === 0,
      'A stop decision carries no items and no carried-over work',
    );
  else
    refuse(
      spec.items.length + carried.length > 0,
      'A continue decision needs at least one item or carried-over workflow',
    );
  return spec;
}
