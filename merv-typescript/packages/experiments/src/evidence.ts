import { isUtf8 } from 'node:buffer';
import { z } from 'zod';
import {
  byCodeUnit,
  visible,
  check,
  markdownSection,
  plain,
  visibleMarkdown,
  type Json,
} from '@merv/contracts';

export const evidenceByteLimit = 64_000;
/** The result files one attempt's exhibit pins. */
export const RESULT_FILES = 100;
function error(condition: unknown, message: string): asserts condition {
  check(condition, 'invalid_experiment_evidence', message);
}
/**
 * Whether evidence read as text is within its bound. Above it, the refusal says what to do with
 * a larger output, which executors otherwise reduced to a list of ids no reviewer could open.
 */
export function boundedEvidence(size: number): void {
  error(
    size > 0 && size <= evidenceByteLimit,
    'Evidence must contain 1–64000 bytes. Compact a JSON result, plan or report; attach a larger or binary output (a checkpoint, an archive, a capture collection) as role result with resultFormat qualitative, which is referenced without being read',
  );
}
/** Retained bytes as the text every other check here reads. */
export function decodeEvidence(bytes: Uint8Array): string {
  boundedEvidence(bytes.byteLength);
  // NUL is UTF-8 but no text column takes it: a report's Conclusion is stored as its verdict.
  error(isUtf8(bytes) && !bytes.includes(0), 'Evidence must be valid UTF-8 text without NUL');
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
}

export function parseResult(text: string, format: 'json' | 'qualitative'): Json | null {
  error(format === 'json' || format === 'qualitative', 'Result format must be json or qualitative');
  if (format === 'qualitative') return null;
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
const feasibilitySchema = z.strictObject({
  formatVersion: z.literal(1),
  resources: z
    .array(
      z.strictObject({
        kind: z.enum(['data', 'compute', 'time']),
        name: line(200),
        unit: line(64),
        required: quantity,
        available: quantity,
        basis: line(2000),
      }),
    )
    .min(1)
    .max(50),
  dependencies: z
    .array(z.object({ name: line(200), present: z.boolean(), basis: line(2000) }).strict())
    .max(50),
  blockers: z.array(line(2000)).max(20),
});

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
    `Feasibility statement is malformed at ${issue?.path.join('.') || 'the top level'}: ${issue?.message}. It has exactly formatVersion, resources (kind, name, unit, required, available, basis), dependencies (name, present, basis) and blockers (plain strings); put other observations in a basis or the plan, then retain and attach a corrected statement`,
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
    // Alt text stops at a bracket, so each `![` scans only to the next one: linear, not quadratic.
    /!\[(?:\\.|[^[\]\\])*\]\(\s*<?(art_[A-Za-z0-9_.:-]+)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g,
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
    error(markdownSection(text, heading), `Evidence requires a nonempty ${heading} section`);
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
  return markdownSection(text, 'Conclusion');
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
  error(
    input.sources.length <= RESULT_FILES,
    `An exhibit pins at most ${RESULT_FILES} result files`,
  );
  const resultFiles = [...input.sources]
    .sort((a, b) => byCodeUnit(a.path, b.path))
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
    projectId: input.projectId,
    experimentId: input.experimentId,
    attemptIndex: input.attemptIndex,
    window: { startedAt: input.startedAt ?? '' },
    resultFiles,
    verdict: { resultFiles: resultFiles.length },
  };
}

/**
 * Canonical pretty JSON: sorted UTF-16 object keys, original arrays/scalars, one trailing newline.
 * An array of scalars is one compact line, so per-example scores cost their own bytes, not a
 * line each.
 */
export function exhibitBytes(exhibit: MetricsExhibit): Buffer {
  const value = safeJson(exhibit, true);
  const pretty = (item: Json, depth = 0): string => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    const pad = '  '.repeat(depth),
      inner = `${pad}  `;
    if (Array.isArray(item))
      return item.some((child) => child !== null && typeof child === 'object')
        ? `[\n${item.map((child) => `${inner}${pretty(child, depth + 1)}`).join(',\n')}\n${pad}]`
        : JSON.stringify(item);
    const keys = Object.keys(item).sort();
    return keys.length
      ? `{\n${keys.map((key) => `${inner}${JSON.stringify(key)}: ${pretty(item[key], depth + 1)}`).join(',\n')}\n${pad}}`
      : '{}';
  };
  const bytes = Buffer.from(`${pretty(value)}\n`, 'utf8');
  error(bytes.byteLength <= 2_000_000, 'Metrics exhibit exceeds the retained artifact size limit');
  return bytes;
}
