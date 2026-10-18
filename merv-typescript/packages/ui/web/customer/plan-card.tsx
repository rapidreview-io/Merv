import { Markdown } from '../markdown';

/**
 * The plan drawn in the report card's language (packages/reports/src/format/html.ts): a title
 * across the page, a band of two equal halves (the question on the left, what counts as success
 * on the right), a rule, then the remaining sections as blocks in three columns. The document
 * stays free text; headings only decide where a section sits.
 */

interface Section {
  name: string;
  body: string;
}

const QUESTION = /^(question|research question|the question|inquiry|aim|goal|objective)s?$/i;
const SUCCESS =
  /^(success( criteria)?|criteria|acceptance criteria|what counts as success|hypothesis and criteria)$/i;
const WIDE = /^(method|methods|approach|design|procedure|execution|plan)$/i;

export function splitPlan(document: string): {
  title: string | null;
  lead: string;
  sections: Section[];
} {
  const lines = document.replace(/\r\n/g, '\n').split('\n');
  let title: string | null = null;
  const lead: string[] = [];
  const sections: Section[] = [];
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h1 = !fence && /^#\s+(.+?)\s*#*\s*$/.exec(line);
    const h2 = !fence && /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h1 && title === null && !sections.length) title = h1[1]!;
    else if (h2) sections.push({ name: h2[1]!, body: '' });
    else if (sections.length) sections[sections.length - 1]!.body += line + '\n';
    else lead.push(line);
  }
  for (const s of sections) s.body = s.body.trim();
  return { title, lead: lead.join('\n').trim(), sections: sections.filter((s) => s.body) };
}

/** Columns a block spans: wide sections and tables take two, very long ones the full width. */
function span(section: Section): 1 | 2 | 3 {
  const words = section.body.split(/\s+/).length;
  const table = /^\s*\|.+\|\s*$/m.test(section.body);
  if (words > 220) return 3;
  if (WIDE.test(section.name) || table || words > 90) return 2;
  return 1;
}

export function PlanCard({
  document,
  status,
  meta,
  limits,
}: {
  document: string;
  /** Where the plan stands, at the left of the mono line above the title. */
  status: string;
  /** The right of that line, e.g. "revision 4 · Oct 14". */
  meta: string;
  /** The accepted contract's limits, shown under the success criteria once agreed. */
  limits?: Record<string, number>;
}) {
  const { title, lead, sections } = splitPlan(document);
  const question = sections.find((s) => QUESTION.test(s.name));
  const success = sections.find((s) => SUCCESS.test(s.name));
  // Without a Question heading, whatever precedes the first section is the question.
  const left = question?.body || lead;
  const body = sections.filter((s) => s !== question && s !== success);
  const bounds = limits ? limitLine(limits) : '';
  return (
    <article className="plan-card">
      <div className="plan-card__meta">
        <span>{status}</span>
        <span>{meta}</span>
      </div>
      {title && <h1>{title}</h1>}
      {(left || success) && (
        <div className="plan-card__band">
          <div className="plan-card__left">{left && <Markdown source={left} />}</div>
          <div className="plan-card__right">
            {success && <Markdown source={success.body} />}
            {bounds && <p className="plan-card__limits">{bounds}</p>}
          </div>
        </div>
      )}
      {body.length > 0 && (
        <>
          <hr className="plan-card__rule" />
          <div className="plan-card__body">
            {body.map((s) => (
              <section key={s.name} className={`plan-card__block span-${span(s)}`}>
                <h2>{s.name}</h2>
                <Markdown source={s.body} />
              </section>
            ))}
          </div>
        </>
      )}
    </article>
  );
}

/** An accepted contract's limits in a line: `3 h · 4M tokens · 2 attempts`. */
export function limitLine(limits: Record<string, number>): string {
  const parts: string[] = [];
  if (limits.wallMinutes) parts.push(`${Math.round((limits.wallMinutes / 60) * 10) / 10} h`);
  if (limits.maxTokens)
    parts.push(
      `${limits.maxTokens >= 1e6 ? `${Math.round(limits.maxTokens / 1e6)}M` : limits.maxTokens} tokens`,
    );
  if (limits.maxAttempts)
    parts.push(`${limits.maxAttempts} attempt${limits.maxAttempts === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
