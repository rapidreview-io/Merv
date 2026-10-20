import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import {
  createSchema,
  endSchema,
  getSchema,
  listSchema,
  advanceSchema,
  replanSchema,
} from './input.js';
import { researchGuide } from './guide.js';
export const researchToolsPlugin = {
  name: 'merv-research-tools',
  inject: ['research', 'tools'],
  apply(ctx: Context) {
    const research = ctx.research;
    ctx.effect(() =>
      ctx.tools.noun('research.read', {
        tier: 'core',
        readOnly: true,
        description:
          'Read research cycles: list (every cycle and the work it waits on), get (one cycle, its accepted definition, gate and child workflow IDs) and lineage (the cycles it follows, with each one’s digest).',
        actions: {
          list: {
            description: 'List research cycles and their exact child workflow references.',
            input: listSchema,
            was: ['research.list'],
            handler: (caller) => research.list(caller),
          },
          get: {
            description:
              'Read a research cycle, its accepted project definition, current outer gate and child workflow IDs. Use workflow.status_and_next for blockers.',
            input: getSchema,
            was: ['research.get'],
            handler: (caller, input) => research.get(caller, input.researchId),
          },
          lineage: {
            description:
              'Read the cycles a research cycle follows, oldest first, each with its immutable digest artifact of what that cycle decided, and the cycle that follows it. Read a digest with artifact.read.',
            input: getSchema,
            was: ['research.lineage'],
            handler: (caller, input) => research.lineage(caller, input.researchId),
          },
        },
      }),
    );
    ctx.effect(() =>
      ctx.tools.noun('research.write', {
        tier: 'core',
        description:
          'Change research cycles: create (start one around existing work), replan (reselect the work it waits on), advance (take its current gate) and end (abandon or fail it).',
        actions: {
          create: {
            description:
              "Start an outer research cycle around selected existing workflow IDs. It coordinates project definition, research and reflection; after reflection approval, a project without Git can complete. When Code hosts the project, accepted code that main does not hold yet is integrated by one consolidation task and published to main, and the cycle completes once main holds it. Before a long hosted cycle, read code.read status for known publication blockers and tell the operator about any repository automation or canary setup it needs; research can proceed while publication waits, and only the operator can attest a canary. This preflight does not verify live GitHub rules. Name a complete, abandoned or failed cycle as previousCycleId to follow it: its digest of what was decided is composed if missing and handed to this cycle's reflection, and a cycle is followed by at most one other. Paper edits are reviewed within scientific workflows. Set automatic: true to advance on completion events and create approved next waves without manual advances; maxCycles bounds the run (default 10). Failed and abandoned work still reaches reflection.",
            input: createSchema,
            was: ['research.create'],
            handler: (caller, input) => research.create(caller, input),
          },
          replan: {
            description:
              'Owner: reselect the existing work a research cycle waits on, while it is still defining or researching. dependsOn is the whole new selection: work missing from it is dropped, work new to it is added. Use it to change the wave scope. New cycles retain failed and abandoned work for reflection.',
            input: replanSchema,
            was: ['research.replan'],
            handler: (caller, input) => research.replan(caller, input),
          },
          advance: {
            act: { title: 'Start next step' },
            description:
              'Advance the current outer gate. New cycles wait for selected work to finish, including failure or abandonment; scientific review approvals remain required. After reflection approval, a project without Git can complete. When Code hosts the project, accepted code that main does not hold yet is handed to one consolidation task; the cycle waits for its acceptance and its publication to main, injects a successor task when main moved first, and completes once main holds it. retryIntegration: true injects a fresh task after one ended without acceptance. Creates the next child workflows atomically, preserving their identities on replay. When the approved reflection carries a structured plan that continues, the advance that completes the cycle requires nextWave: create opens the plan’s tasks, experiments and the next research cycle in the same transaction, under you; skip completes without them. A text change specification creates nothing. Reuse the same requestId and exact expectedRevision for an uncertain response.',
            input: advanceSchema,
            was: ['research.advance'],
            handler: (caller, input) => research.advance(caller, input),
          },
          end: {
            description:
              'Owner: end a research cycle that cannot reach an answer, as abandoned when the question is no longer worth pursuing or failed when it was pursued and cannot be completed. Its reflection and consolidation keep their own records and are ended separately. Requires a specific reason and the current revision. This is terminal.',
            input: endSchema,
            was: ['research.end'],
            handler: (caller, input) => research.end(caller, input),
          },
        },
      }),
    );
    // Research composes the product, so it tells every main agent how Merv's research works.
    ctx.effect(() => ctx.tools.contributeInstructions(researchGuide));
  },
};
export default researchToolsPlugin;
