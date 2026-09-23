import { isUtf8 } from 'node:buffer';
import { z } from 'zod';
import {
  visible,
  check,
  markdownSection,
  plain,
  visibleMarkdown,
  type Json,
} from '@merv/contracts';

export const evidenceByteLimit = 64_000;
function error(condition: unknown, message: string): asserts condition {
  check(condition, 'invalid_experiment_evidence', message);
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Retained bytes as the text every other check here reads. */
export function decodeEvidence(bytes: Uint8Array): string {
  error(
    bytes.byteLength > 0 && bytes.byteLength <= evidenceByteLimit,
    'Evidence must contain 1–64000 bytes',
  );
  error(isUtf8(bytes), 'Evidence must contain valid UTF-8');
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
  error(visible(text), 'Evidence must not be empty');
  return text;
}

function safeJson(input: unknown, aggregate = false): Json {
  try {
    return plain(input, 'invalid_experiment_input', {
      keys: 'any',
      depth: 20,
      ...(aggregate ? { bytes: 2_000_000, nodes: 262144 } : { bytes: 262144, nodes: 8192 }),
    });
  } catch {
    error(false, 'Evidence must contain bounded, finite plain JSON');
  }
  throw new Error('unreachable');
}

function parseJson(text: string): Json {
  let value: unknown;
  try {
    // An integer JSON can write but a double cannot hold would be read back changed.
    value = JSON.parse(text, (_key, item, context?: { source?: string }) => {
      if (
        typeof item === 'number' &&
        !Number.isSafeInteger(item) &&
        /^-?\d+$/.test(context?.source ?? '')
      )
        throw new RangeError(context!.source);
      return item;
    });
  } catch (cause) {
    error(
      !(cause instanceof RangeError),
      `Results must use integers up to 2^53−1; ${(cause as Error).message} would be read back changed, so write it as a string`,
    );
    error(
      false,
      'Result is not valid JSON; attach a non-JSON result with resultFormat qualitative',
    );
  }
  return safeJson(value);
}

export function parseResult(text: string, format: 'json' | 'qualitative'): Json | null {
  error(format === 'json' || format === 'qualitative', 'Result format must be json or qualitative');
  return format === 'json' ? parseJson(text) : null;
}

/**
 * What a design requires against what exists, stated by its author before design review.
 * The field failures this answers were arithmetic — a corpus smaller than every training arm —
 * so the quantities are numbers the server can compare, and each names the basis it was
 * measured from so an independent reviewer can recompute it.
 */
export interface FeasibilityStatement {
  formatVersion: 1;
  resources: {
    kind: 'data' | 'compute' | 'time';
    name: string;
    unit: string;
    required: number;
    available: number;
    basis: string;
  }[];
  dependencies: { name: string; present: boolean; basis: string }[];
  blockers: string[];
}
const quantity = z.number().finite().nonnegative();
const line = (max: number) => z.string().max(max).refine(visible);
const feasibilitySchema = z
  .object({
    formatVersion: z.literal(1),
    resources: z
      .array(
        z
          .object({
            kind: z.enum(['data', 'compute', 'time']),
            name: line(200),
            unit: line(64),
            required: quantity,
            available: quantity,
            basis: line(2000),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    dependencies: z
      .array(z.object({ name: line(200), present: z.boolean(), basis: line(2000) }).strict())
      .max(50),
    blockers: z.array(line(2000)).max(20),
  })
  .strict();

/** Checks the shape of a feasibility statement only; whether it admits the design is a separate question. */
export function parseFeasibility(text: string): FeasibilityStatement {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    error(false, 'A feasibility statement must be valid JSON');
  }
  const parsed = feasibilitySchema.safeParse(safeJson(value));
  const issue = parsed.error?.issues[0];
  error(
    parsed.success,
    `Feasibility statement is malformed at ${issue?.path.join('.') || 'the top level'}: ${issue?.message}`,
  );
  // The observed failure was a corpus too small for the design, so the data is never left unstated.
  error(
    parsed.data.resources.some((resource) => resource.kind === 'data'),
    'A feasibility statement must state at least one data resource',
  );
  return parsed.data;
}

/** One line for each reason the statement's own figures do not admit the design. */
export function feasibilityShortfalls(statement: FeasibilityStatement): string[] {
  return [
    ...statement.resources
      .filter((resource) => resource.available < resource.required)
      .map(
        (resource) =>
          `${resource.kind} ${resource.name}: ${resource.available} ${resource.unit} available, ${resource.required} required`,
      ),
    ...statement.dependencies
      .filter((dependency) => !dependency.present)
      .map((dependency) => `dependency ${dependency.name} is not present`),
    ...statement.blockers.map((blocker) => `blocker: ${blocker}`),
  ];
}

const section = (text: string, title: string) => markdownSection(text, title);

/** Only retained artifact images are supported; the caller verifies bytes, media type and scope. */
export function markdownImageTargets(text: string): string[] {
  const visible = visibleMarkdown(text)
    .replace(/(`+)[\s\S]*?\1/g, '')
    .replace(/\\!/g, '');
  error(
    !/<\s*(?:img|picture|svg)\b/i.test(visible),
    'Use Markdown images that reference retained image artifacts',
  );
  const targets: string[] = [];
  const remainder = visible.replace(
    /!\[(?:\\.|[^\]\\])*\]\(\s*<?(art_[A-Za-z0-9_.:-]+)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g,
    (_match, target: string) => {
      targets.push(target);
      return '';
    },
  );
  error(
    !/!\[/.test(remainder),
    'Images must use inline art_ID targets; URLs, paths and reference images are unsupported',
  );
  return [...new Set(targets)];
}

function validateDocument(
  text: string,
  headings: readonly string[],
  figures: readonly string[] = [],
): void {
  for (const heading of headings)
    error(section(text, heading), `Evidence requires a nonempty ${heading} section`);
  const verified = new Set(figures);
  for (const target of markdownImageTargets(text))
    error(verified.has(target), 'Every figure must be a verified retained image artifact');
}

export function validatePlan(text: string, options: { figures?: readonly string[] } = {}): void {
  validateDocument(text, ['Summary', 'Objective and hypothesis', 'Evaluation'], options.figures);
}

export function validateReport(
  text: string,
  options: { figures?: readonly string[]; exhibitPath?: string } = {},
): void {
  validateDocument(
    text,
    ['Summary', 'Results', 'Deviations from plan', 'Conclusion'],
    options.figures,
  );
  if (options.exhibitPath) {
    const filename = options.exhibitPath.split('/').at(-1)!;
    error(
      filename.length > 0 && visibleMarkdown(text).includes(filename),
      'Report must reference the pinned metrics exhibit filename',
    );
  }
}

export function reportConclusion(text: string): string | null {
  return section(text, 'Conclusion');
}

export interface MetricsResultSource {
  path: string;
  artifactId: string;
  sha256: string;
  submittedAt: string;
  data: Json | null;
  resultFormat: 'json' | 'qualitative';
}
export interface MetricsExhibit {
  kind: 'metrics_exhibit';
  projectId: string;
  experimentId: string;
  attemptIndex: number;
  window: { startedAt: string };
  resultFiles: {
    path: string;
    data: Json | null;
    source: {
      type: 'result_file';
      path: string;
      artifactId: string;
      sha256: string;
      submittedAt: string;
      resultFormat: 'json' | 'qualitative';
    };
  }[];
  verdict: { resultFiles: number };
}

export function shouldPinExhibit(
  sources: readonly Pick<MetricsResultSource, 'resultFormat'>[],
): boolean {
  return sources.some((source) => source.resultFormat === 'json');
}

export function buildMetricsExhibit(input: {
  projectId: string;
  experimentId: string;
  attemptIndex: number;
  startedAt: string | null;
  sources: MetricsResultSource[];
}): MetricsExhibit {
  // Built from sealed result slots, whose key already makes each path unique.
  const value = input;
  error(value.sources.length <= 100, 'An exhibit pins at most 100 result files');
  const resultFiles = [...value.sources]
    .sort((a, b) => compare(a.path, b.path))
    .map((source) => {
      error(
        source.data !== undefined && (source.resultFormat === 'json' || source.data === null),
        'Qualitative results must not claim parsed JSON data',
      );
      return {
        path: source.path,
        data: source.data as Json,
        source: {
          type: 'result_file' as const,
          path: source.path,
          artifactId: source.artifactId,
          sha256: source.sha256,
          submittedAt: source.submittedAt,
          resultFormat: source.resultFormat,
        },
      };
    });
  return {
    kind: 'metrics_exhibit',
    projectId: value.projectId,
    experimentId: value.experimentId,
    attemptIndex: value.attemptIndex,
    window: { startedAt: value.startedAt ?? '' },
    resultFiles,
    verdict: { resultFiles: resultFiles.length },
  };
}

/** Canonical pretty JSON: sorted UTF-16 object keys, original arrays/scalars, one trailing newline. */
export function exhibitBytes(exhibit: MetricsExhibit): Buffer {
  const value = safeJson(exhibit, true);
  const pretty = (item: Json, depth = 0): string => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    const pad = '  '.repeat(depth),
      inner = `${pad}  `;
    if (Array.isArray(item))
      return item.length
        ? `[\n${item.map((child) => `${inner}${pretty(child, depth + 1)}`).join(',\n')}\n${pad}]`
        : '[]';
    const keys = Object.keys(item).sort(compare);
    return keys.length
      ? `{\n${keys.map((key) => `${inner}${JSON.stringify(key)}: ${pretty(item[key], depth + 1)}`).join(',\n')}\n${pad}}`
      : '{}';
  };
  const bytes = Buffer.from(`${pretty(value)}\n`, 'utf8');
  error(bytes.byteLength <= 2_000_000, 'Metrics exhibit exceeds the retained artifact size limit');
  return bytes;
}
