// Parse and check an agent-written report. Headings are fixed: the renderer decides where each
// section goes, so an unknown heading is an error.

import YAML from 'yaml';
import { marked, type Token, type Tokens } from 'marked';
import { validateSpec, words, type ChartSpec, type Criterion, type Issue } from './spec.js';

export interface SectionRule {
  zone: 'left' | 'right' | 'body';
  required: boolean;
  words?: number;
  bullets?: number;
}
export const SECTIONS: Record<string, SectionRule> = {
  Inquiry: { zone: 'left', required: true, words: 90 },
  Constraints: { zone: 'left', required: true, bullets: 8 },
  Result: { zone: 'right', required: true, words: 15 },
  Method: { zone: 'body', required: true, words: 80 },
  Execution: { zone: 'body', required: true, words: 110 },
  Data: { zone: 'body', required: true, words: 40 },
  Verification: { zone: 'body', required: true, words: 60 },
  Discussion: { zone: 'body', required: false, words: 70 },
  Limitations: { zone: 'body', required: true, words: 60, bullets: 4 },
  Next: { zone: 'body', required: false, words: 20 },
  References: { zone: 'body', required: false },
};
export const SECTION_ORDER = Object.keys(SECTIONS);
export const RESULT_NOTE_WORDS = 40;
/** Text a prefilled draft leaves for the agent; a report that still contains it is not done. */
export const PLACEHOLDER = /\[\[write:[^\]]*\]\]/;

export interface Block {
  type: string;
  token?: Token;
  chart?: Chart;
}
export interface Section {
  name: string;
  zone: SectionRule['zone'];
  tokens: Token[];
  blocks: Block[];
}
export interface Chart {
  spec: ChartSpec;
  section: string;
}
export interface Report {
  meta: Record<string, unknown>;
  criteria: Criterion[];
  title: string | null;
  sections: Section[];
  charts: Chart[];
  issues: Issue[];
}
export interface ParseOptions {
  /** Section names (and 'title') fixed by the approved plan: exempt from limits, never edited. */
  locked?: readonly string[];
  /** Report data files and resolvable artifact keys (`artifact:<id>`) charts may name. */
  files?: ReadonlySet<string>;
}

/** Split a report into front matter, title and `##` sections, ignoring headings inside code fences. */
export function splitReport(source: string): {
  frontMatter: string | null;
  title: string | null;
  preamble: string;
  sections: { name: string; body: string }[];
} {
  let body = source.replace(/\r\n/g, '\n');
  let frontMatter: string | null = null;
  const fm = body.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    frontMatter = fm[1];
    body = body.slice(fm[0].length);
  }
  let title: string | null = null;
  const preamble: string[] = [];
  const sections: { name: string; body: string[] }[] = [];
  let fence = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^# (?!#)/.test(line) && title === null && !sections.length) {
      title = line.slice(2).trim();
      continue;
    }
    if (!fence && /^## (?!#)/.test(line)) {
      sections.push({ name: line.slice(3).trim(), body: [] });
      continue;
    }
    if (sections.length) sections[sections.length - 1].body.push(line);
    else preamble.push(line);
  }
  return {
    frontMatter,
    title,
    preamble: preamble.join('\n').trim(),
    sections: sections.map((s) => ({ name: s.name, body: s.body.join('\n').trim() })),
  };
}

export function joinReport(parts: {
  frontMatter: string | null;
  title: string | null;
  sections: { name: string; body: string }[];
}): string {
  const out: string[] = [];
  if (parts.frontMatter !== null) out.push(`---\n${parts.frontMatter.trim()}\n---`);
  if (parts.title !== null) out.push(`# ${parts.title}`);
  for (const s of parts.sections) out.push(`## ${s.name}\n\n${s.body.trim()}`);
  return out.join('\n\n') + '\n';
}

export function parseReport(source: string, options: ParseOptions = {}): Report {
  const locked = new Set(options.locked ?? []);
  const issues: Issue[] = [];
  const err = (where: string, message: string) => issues.push({ level: 'error', where, message });
  const warn = (where: string, message: string) =>
    issues.push({ level: 'warning', where, message });

  let meta: Record<string, unknown> = {};
  let body = source.replace(/\r\n/g, '\n');
  const fm = body.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    try {
      const parsed = YAML.parse(fm[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
      else err('front matter', 'front matter must be a YAML mapping');
    } catch (e) {
      err('front matter', `front matter is not valid YAML: ${(e as Error).message.split('\n')[0]}`);
    }
    body = body.slice(fm[0].length);
  } else err('front matter', 'missing --- front matter with id and date');
  for (const key of ['id', 'date']) if (!meta[key]) err('front matter', `${key} is required`);
  for (const key of Object.keys(meta))
    if (!['id', 'date', 'criteria'].includes(key))
      err('front matter', `"${key}" is not allowed (allowed: id, date, criteria)`);
  const criteria = parseCriteria(meta.criteria, err);

  if (PLACEHOLDER.test(source)) {
    const names = splitReport(source)
      .sections.filter((s) => PLACEHOLDER.test(s.body))
      .map((s) => s.name);
    err(
      names.join(', ') || 'report',
      'still has [[write: …]] placeholders; replace them with content',
    );
  }

  const tokens = marked.lexer(body);
  let title: string | null = null;
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const t of tokens) {
    if (t.type === 'heading' && (t as Tokens.Heading).depth === 1) {
      if (title) err('title', 'only one # title is allowed');
      title = (t as Tokens.Heading).text.trim();
      continue;
    }
    if (t.type === 'heading' && (t as Tokens.Heading).depth === 2) {
      current = { name: (t as Tokens.Heading).text.trim(), zone: 'body', tokens: [], blocks: [] };
      sections.push(current);
      continue;
    }
    if (t.type === 'heading') {
      err(
        current?.name ?? 'top',
        `### and deeper headings are not allowed ("${(t as Tokens.Heading).text}")`,
      );
      continue;
    }
    if (t.type === 'space') continue;
    if (!current) {
      err('top', 'content before the first ## section');
      continue;
    }
    current.tokens.push(t);
  }

  if (!title) err('title', 'missing # question title');
  else if (!locked.has('title')) {
    if (words(title) > 16) err('title', 'title is longer than 16 words');
    if (!title.endsWith('?'))
      warn('title', 'the title should be the question the experiment answers');
  }

  const charts: Chart[] = [];
  let last = -1;
  const seen = new Set<string>();
  for (const s of sections) {
    const rule = SECTIONS[s.name];
    if (!rule) {
      err(s.name, `unknown section; allowed: ${SECTION_ORDER.join(', ')}`);
      continue;
    }
    if (seen.has(s.name)) err(s.name, 'section appears twice');
    seen.add(s.name);
    const idx = SECTION_ORDER.indexOf(s.name);
    if (idx < last) err(s.name, `out of order; sections go ${SECTION_ORDER.join(' → ')}`);
    last = Math.max(last, idx);
    s.zone = rule.zone;
    const free = !locked.has(s.name);
    let prose = 0;
    for (const t of s.tokens) {
      if (t.type === 'code' && ((t as Tokens.Code).lang ?? '').split(/\s/)[0] === 'chart') {
        let spec: ChartSpec;
        try {
          spec = JSON.parse((t as Tokens.Code).text);
        } catch (e) {
          err(s.name, `chart is not valid JSON: ${(e as Error).message}`);
          continue;
        }
        for (const i of validateSpec(spec))
          issues.push({ ...i, where: `${s.name} chart ${spec?.id ?? '?'}` });
        if (spec?.id && charts.some((c) => c.spec.id === spec.id))
          err(s.name, `duplicate chart id ${spec.id}`);
        if (options.files)
          for (const key of chartRefs(spec))
            if (!options.files.has(key))
              err(
                `${s.name} chart ${spec.id}`,
                `data ${key.replace(/^artifact:/, 'artifact ')} does not exist`,
              );
        const chart: Chart = { spec, section: s.name };
        charts.push(chart);
        s.blocks.push({ type: 'chart', chart });
        continue;
      }
      if (t.type === 'code') {
        err(s.name, 'code blocks other than ```chart are not allowed');
        continue;
      }
      if (
        t.type === 'paragraph' &&
        /^(figure|fig\.|table|caption)\s*\d*[.:]/i.test((t as Tokens.Paragraph).text.trim())
      )
        err(
          s.name,
          'captions are not allowed; put needed context on the chart (axis title, labels)',
        );
      if (t.type === 'paragraph' || t.type === 'list')
        prose += words(t.raw.replace(/\[\d+\]/g, ''));
      if (
        t.type === 'list' &&
        rule.bullets &&
        free &&
        (t as Tokens.List).items.length > rule.bullets
      )
        err(s.name, `at most ${rule.bullets} bullets`);
      if (t.type === 'list' && free)
        for (const item of (t as Tokens.List).items)
          if (words(item.text) > 25)
            err(s.name, `a bullet is ${words(item.text)} words; keep bullets to 25`);
      if (t.type === 'blockquote' || t.type === 'hr' || t.type === 'html' || t.type === 'image') {
        err(s.name, `${t.type} is not allowed`);
        continue;
      }
      s.blocks.push({ type: t.type, token: t });
    }
    if (free && rule.words && s.name !== 'Result' && prose > rule.words)
      err(s.name, `${prose} words; the limit is ${rule.words}`);
    if (s.name === 'Constraints' && !(s.tokens.length === 1 && s.tokens[0].type === 'list'))
      err(s.name, 'must be exactly one bullet list');
    if (s.name === 'Result') checkResult(s, err);
    if (s.name === 'References') {
      const list = s.tokens[0] as Tokens.List | undefined;
      if (!(s.tokens.length === 1 && list?.type === 'list' && list.ordered))
        err(s.name, 'must be one numbered list');
      else
        for (const item of list.items)
          if (!/,\s*\d{4}\s*$/.test(item.text))
            err(s.name, `"${item.text}" must end with ", YEAR"`);
    }
  }
  for (const name of SECTION_ORDER)
    if (SECTIONS[name].required && !seen.has(name)) err(name, 'required section is missing');

  const refs = sections.find((s) => s.name === 'References');
  const refCount = (refs?.tokens[0] as Tokens.List | undefined)?.items?.length ?? 0;
  const cited = new Set<number>();
  for (const s of sections)
    if (s.name !== 'References')
      for (const t of s.tokens)
        for (const m of (t.raw ?? '').matchAll(/\[(\d+)\]/g)) cited.add(Number(m[1]));
  for (const n of cited)
    if (n < 1 || n > refCount) err('References', `[${n}] is cited but there is no reference ${n}`);
  for (let n = 1; n <= refCount; n++)
    if (!cited.has(n)) err('References', `reference ${n} is never cited`);

  return { meta, criteria, title, sections, charts, issues };
}

function checkResult(s: Section, err: (where: string, message: string) => void): void {
  const first = s.tokens[0];
  if (!first || first.type !== 'paragraph') err(s.name, 'must start with the one-line answer');
  else if (words((first as Tokens.Paragraph).text) > SECTIONS.Result.words!)
    err(
      s.name,
      `the answer is ${words((first as Tokens.Paragraph).text)} words; the limit is ${SECTIONS.Result.words}`,
    );
  const chartAt = s.tokens.findIndex((t) => t.type === 'code');
  if (chartAt < 0)
    err(
      s.name,
      'needs one chart: every criterion against its bar, or the measured results when there are no criteria',
    );
  const paras = s.tokens.filter((t) => t.type === 'paragraph');
  const after =
    chartAt < 0 ? [] : s.tokens.slice(chartAt + 1).filter((t) => t.type === 'paragraph');
  if (s.tokens.filter((t) => t.type === 'code').length > 1)
    err(s.name, 'only one chart belongs here');
  if (paras.length > 2 || (paras.length === 2 && after.length !== 1))
    err(s.name, 'the answer, its chart, then at most one short description below the chart');
  if (after[0] && words((after[0] as Tokens.Paragraph).text) > RESULT_NOTE_WORDS)
    err(
      s.name,
      `the description is ${words((after[0] as Tokens.Paragraph).text)} words; the limit is ${RESULT_NOTE_WORDS}`,
    );
  if (s.tokens.some((t) => t.type === 'list' || t.type === 'table'))
    err(s.name, 'no lists or tables here');
}

function parseCriteria(value: unknown, err: (where: string, message: string) => void): Criterion[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    err('front matter', 'criteria must be a list of {metric, bar} or {metric, floor}');
    return [];
  }
  const out: Criterion[] = [];
  value.forEach((c, i) => {
    const at = `criteria[${i}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c))
      return err(
        'front matter',
        `${at} must be a mapping; quote a metric name that contains commas or colons`,
      );
    const keys = Object.keys(c);
    for (const k of keys)
      if (!['metric', 'bar', 'floor'].includes(k))
        err(
          'front matter',
          `${at}: "${k}" is not allowed (metric, bar, floor); quote a metric name that contains commas or colons`,
        );
    if (typeof c.metric !== 'string' || !c.metric.trim())
      return err('front matter', `${at}.metric must be text`);
    const bounds = ['bar', 'floor'].filter((k) => c[k] !== undefined);
    if (bounds.length !== 1 || typeof c[bounds[0]] !== 'number')
      return err('front matter', `${at} needs exactly one numeric bar or floor`);
    out.push(c as Criterion);
  });
  return out;
}

function chartRefs(spec: ChartSpec): string[] {
  const refs = [
    spec?.data,
    ...(Array.isArray(spec?.layer) ? spec.layer.map((l: any) => l?.data) : []),
  ];
  return refs.flatMap((d: any) =>
    d?.file ? [d.file] : d?.artifact ? [`artifact:${d.artifact}`] : [],
  );
}
