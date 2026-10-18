/** Pure: other packages run this to build their subject's first draft. */

/** What the writer of a report is granted to finish that draft (packages/reports/src/tools.ts). */
export const REPORT_TOOLS = [
  'report.open',
  'report.write',
  'report.clear',
  'report.check',
  'report.review_visual',
  'report.approve_visual',
  'report.render',
];

/** What an approved plan fixes for its report. */
export interface PlanFacts {
  id: string;
  /** The question the experiment answers. */
  question: string;
  /** Why it was asked, what is tested and which decision it informs. */
  inquiry: string;
  /** Approved criteria, budget and limits, one bullet each. */
  constraints: string[];
  /** Method material from the plan (an arms table, steps); the agent completes it. */
  method?: string;
  /** Data rows already known (validated uploads); the agent completes the table. */
  data?: { dataset: string; use: string; size: string }[];
}

const yaml = (s: string) => JSON.stringify(s);
const bullet = (s: string) => `- ${s.replace(/\s+/g, ' ').trim()}`;
const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

/** A first draft: the plan's sections locked, every other section a placeholder to replace. */
export function draftFromPlan(
  plan: PlanFacts,
  date = new Date().toISOString().slice(0, 10),
): { source: string; locked: string[] } {
  const question = plan.question
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^question:\s*/i, '');
  const title = /[?]$/.test(question) ? question : `${question}?`;
  const constraints = plan.constraints.map((c) => c.trim()).filter(Boolean);
  const data = plan.data?.length
    ? [
        '| Dataset | Use | Size |',
        '|---|---|---|',
        ...plan.data.map((d) => `| ${cell(d.dataset)} | ${cell(d.use)} | ${cell(d.size)} |`),
      ].join('\n')
    : '[[write: a table of every dataset used: Dataset | Use | Size]]';
  const source = `---
id: ${yaml(plan.id)}
date: ${yaml(date)}
criteria: []
---

# ${title}

## Inquiry

${plan.inquiry.trim() || '[[write: why this was asked and which decision it informs]]'}

## Constraints

${(constraints.length ? constraints : ['[[write: the approved success criteria and budget]]']).map(bullet).join('\n')}

## Result

[[write: the answer in one line of at most 15 words, no caveats]]

[[write: one chart block of every criterion against its bar; then optionally one paragraph of at most 40 words for nuance]]

## Method

${plan.method?.trim() ? `${plan.method.trim()}\n\n` : ''}[[write: how it was tested, at most 80 words]]

## Execution

[[write: what ran, wall time, cost against budget, and every deviation or incident by id; add charts where they show something]]

## Data

${data}

## Verification

[[write: how the results were checked: recomputation, reruns, leakage or overlap checks; at most 60 words]]

## Limitations

- [[write: at most 4 bullets]]
`;
  return { source, locked: ['title', 'Inquiry', 'Constraints'] };
}
