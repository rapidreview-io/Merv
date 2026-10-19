import { check, type Caller, type Transaction } from '@merv/contracts';
import { draftFromPlan } from '@merv/reports/prefill';
import type { ReportSubject } from '@merv/reports/types';
import type { CustomerExperiments } from './domain.js';
import {
  isDocumentContract,
  type CustomerExperiment,
  type DocumentContract,
  type PlanLimits,
} from './types.js';

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

const hours = (minutes: number) =>
  `${Math.round((minutes / 60) * 10) / 10} hours of agent working time`;
const tokens = (n: number) => (n >= 1e6 ? `${Math.round(n / 1e6)}M` : `${n}`) + ' model tokens';

const allowance = (limits: PlanLimits) =>
  `Up to ${hours(limits.wallMinutes)}, ${tokens(limits.maxTokens)} and ${limits.maxAttempts} execution attempt${limits.maxAttempts === 1 ? '' : 's'}`;
const size = (bytes: number) =>
  bytes >= 1e9
    ? `${Math.round(bytes / 1e8) / 10} GB`
    : bytes >= 1e6
      ? `${Math.round(bytes / 1e5) / 10} MB`
      : `${Math.max(1, Math.round(bytes / 1e3))} KB`;

/** Version 3: the verified summary, why the plan says it was asked, and the files. */
function documentFacts(exp: CustomerExperiment, contract: DocumentContract) {
  return {
    id: exp.title,
    question: contract.question,
    inquiry: inquiryOf(contract.document) || contract.question,
    // What the person agreed success means; Merv's own limits are not theirs to read.
    constraints: contract.criteria,
    data: contract.files.map((f) => ({ dataset: f.key, use: 'Request file', size: size(f.size) })),
  };
}

/** Why it was asked: the plan's hypothesis-and-decision section where it has one, else its first
 *  paragraph of prose. Headings are dropped, wherever they sit in a block. */
export function inquiryOf(document: string): string {
  const sections: { heading: string; text: string }[] = [];
  for (const line of document.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (heading) sections.push({ heading: heading[1]!.toLowerCase(), text: '' });
    else if (sections.length) sections.at(-1)!.text += `${line}\n`;
    else sections.push({ heading: '', text: `${line}\n` });
  }
  const prose = (text: string) => text.trim().replace(/\n{3,}/g, '\n\n');
  const why = sections.find(
    (s) => /hypothesis|decision|why|purpose/.test(s.heading) && prose(s.text),
  );
  const first = sections.find((s) => !/^question$/.test(s.heading) && prose(s.text));
  return prose((why ?? first)?.text ?? '').slice(0, 2000);
}

function facts(exp: CustomerExperiment) {
  if (exp.contract && isDocumentContract(exp.contract)) return documentFacts(exp, exp.contract);
  const plan = exp.contract?.plan;
  if (!plan) return { id: exp.title, question: exp.title, inquiry: '', constraints: [] };
  const { limits } = plan;
  return {
    id: exp.title,
    question: plan.question,
    inquiry: [plan.rationale, plan.decision ? `The answer decides: ${plan.decision}` : '']
      .filter(Boolean)
      .join(' '),
    constraints: [...plan.successCriteria, allowance(limits)],
    method: [
      ...plan.method.map((step, i) => `${i + 1}. ${step}`),
      ...(plan.baseline ? ['', `Baseline: ${plan.baseline}. Metric: ${plan.metric}.`] : []),
    ].join('\n'),
    data: (exp.contract && !isDocumentContract(exp.contract) ? exp.contract.datasets : []).map(
      (d) => {
        const requirement = plan.dataRequirements.find((r) => r.id === d.requirementId);
        return {
          dataset: d.filename,
          use: requirement?.role ?? d.requirementId,
          size: `${d.rows.toLocaleString('en-US')} rows`,
        };
      },
    ),
  };
}
