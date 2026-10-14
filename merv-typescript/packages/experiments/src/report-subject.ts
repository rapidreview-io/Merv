import { check, markdownSection, type Caller, type Transaction } from '@merv/contracts';
import { draftFromPlan } from '@merv/reports/prefill';
import type { ReportSubject } from '@merv/reports/types';
import type { ExperimentsContext } from './index.js';
import { holds } from './lease.js';
import { approvedSubmission } from './program.js';
import { decodeEvidence } from './evidence.js';
import type { Experiment } from './models.js';

/** The report of a research experiment: prefilled from its approved plan, edited by its runner. */
export function experimentReportSubject(ctx: ExperimentsContext): ReportSubject {
  return {
    async authorize(caller: Caller, id: string, mode: 'read' | 'write', tx: Transaction) {
      const experiment = await ctx.get(caller, id, tx);
      if (mode === 'read' || !caller.session) return;
      check(
        experiment.workflow.state === 'running' && (await holds(ctx, caller, experiment, tx)),
        'forbidden',
        'Only the worker running this experiment may edit its report',
        403,
      );
    },
    async prefill(caller: Caller, id: string, tx: Transaction) {
      const experiment = await ctx.get(caller, id, tx);
      return draftFromPlan(await planFacts(ctx, caller, experiment, tx));
    },
  };
}

async function planFacts(ctx: ExperimentsContext, caller: Caller, experiment: Experiment, tx: Transaction) {
  let plan = '';
  try {
    const approved = approvedSubmission(experiment);
    const item = approved.evidence.find((e) => e.role === 'plan');
    if (item) plan = decodeEvidence((await ctx.artifacts.bytes(caller, item.artifactId, tx)).bytes);
  } catch {
    // No approved plan yet: the draft starts from the experiment's own intent.
  }
  const summary = markdownSection(plan, 'Summary') ?? '';
  const question = /question:\s*(.+)/i.exec(summary)?.[1] ?? summary.split('\n')[0] ?? '';
  const evaluation = markdownSection(plan, 'Evaluation') ?? '';
  // The plan's risks follow its evaluation bullets; they are not constraints.
  const risks = evaluation.search(/^\s*risks\b/im);
  const lines = (risks < 0 ? evaluation : evaluation.slice(0, risks)).split('\n');
  const bullets = lines.filter((l) => /^\s*[-*]\s+/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, ''));
  const table = lines.filter((l) => /^\s*\|/.test(l)).join('\n');
  return {
    id: experiment.name,
    question: question.trim() || experiment.intent.split(/(?<=[.?!])\s/)[0] || experiment.name,
    inquiry: markdownSection(plan, 'Objective and hypothesis') ?? experiment.intent,
    constraints: bullets,
    method: table,
  };
}
