import { check, type Caller, type Transaction } from '@merv/contracts';
import { draftFromPlan } from '@merv/reports/prefill';
import type { ReportSubject } from '@merv/reports/types';
import type { CustomerExperiments } from './domain.js';
import type { CustomerExperiment } from './types.js';

/** A customer request's report: prefilled from its accepted contract, edited by its executor. */
export function customerReportSubject(domain: CustomerExperiments): ReportSubject {
  return {
    async authorize(caller: Caller, id: string, mode: 'read' | 'write', tx: Transaction) {
      const exp = await domain.get(caller, id, tx);
      if (mode === 'read' || !caller.session) return;
      check(
        exp.workflow.state === 'running',
        'forbidden',
        'Only the executing worker edits the report while the experiment runs',
        403,
      );
      await domain.worker(caller, exp, tx);
    },
    async prefill(caller: Caller, id: string, tx: Transaction) {
      return draftFromPlan(facts(await domain.get(caller, id, tx)));
    },
  };
}

const hours = (minutes: number) => `${Math.round((minutes / 60) * 10) / 10} worker hours`;
const tokens = (n: number) => (n >= 1e6 ? `${Math.round(n / 1e6)}M` : `${n}`) + ' model tokens';

function facts(exp: CustomerExperiment) {
  const plan = exp.contract?.plan;
  if (!plan) return { id: exp.title, question: exp.title, inquiry: '', constraints: [] };
  const { limits } = plan;
  return {
    id: exp.title,
    question: plan.question,
    inquiry: [plan.rationale, plan.decision ? `The answer decides: ${plan.decision}` : '']
      .filter(Boolean)
      .join(' '),
    constraints: [
      ...plan.successCriteria,
      `Up to ${hours(limits.wallMinutes)}, ${tokens(limits.maxTokens)} and ${limits.maxAttempts} execution attempt${limits.maxAttempts === 1 ? '' : 's'}`,
    ],
    method: [
      ...plan.method.map((step, i) => `${i + 1}. ${step}`),
      ...(plan.baseline ? ['', `Baseline: ${plan.baseline}. Metric: ${plan.metric}.`] : []),
    ].join('\n'),
    data: (exp.contract?.datasets ?? []).map((d) => {
      const requirement = plan.dataRequirements.find((r) => r.id === d.requirementId);
      return {
        dataset: d.filename,
        use: requirement?.role ?? d.requirementId,
        size: `${d.rows.toLocaleString('en-US')} rows`,
      };
    }),
  };
}
