import { isUtf8 } from 'node:buffer';
import { types } from 'node:util';
import { z } from 'zod';
import {
  visible,
  check,
  markdownSection,
  plain,
  visibleMarkdown,
  type Json,
} from '@merv/contracts';
import { experimentIdSchema, experimentPathSchema } from './input.js';

export const evidenceByteLimit = 16_000;
function error(condition: unknown, message: string): asserts condition {
  check(condition, 'invalid_experiment_evidence', message);
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const arrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;

export function decodeEvidence(bytes: Uint8Array): string {
  error(!types.isProxy(bytes) && types.isUint8Array(bytes), 'Evidence must be UTF-8 bytes');
  const size = byteLength.call(bytes) as number;
  error(size > 0 && size <= evidenceByteLimit, 'Evidence must contain 1–16000 bytes');
  const view = Buffer.from(arrayBuffer.call(bytes), byteOffset.call(bytes), size);
  error(isUtf8(view), 'Evidence must contain valid UTF-8');
  const text = view.toString('utf8');
  error(visible(text), 'Evidence must not be empty');
  return text;
}

function boundedText(text: string): string {
  error(typeof text === 'string', 'Evidence must be text');
  error(
    Buffer.byteLength(text, 'utf8') <= evidenceByteLimit,
    'Evidence must contain 1–16000 bytes',
  );
  return decodeEvidence(Buffer.from(text, 'utf8'));
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
  boundedText(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    error(
      false,
      'Result is not valid JSON; attach a non-JSON result with resultFormat qualitative',
    );
  }
  return safeJson(value);
}

export function parseResult(text: string, format: 'json' | 'qualitative'): Json | null {
  boundedText(text);
  error(format === 'json' || format === 'qualitative', 'Result format must be json or qualitative');
  return format === 'json' ? parseJson(text) : null;
}

const section = (text: string, title: string) => markdownSection(boundedText(text), title);

/** Only retained artifact images are supported; the caller verifies bytes, media type and scope. */
export function markdownImageTargets(text: string): string[] {
  const visible = visibleMarkdown(boundedText(text))
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
      filename.length > 0 && visibleMarkdown(boundedText(text)).includes(filename),
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
const sourceSchema = z
  .object({
    path: experimentPathSchema,
    artifactId: experimentIdSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    submittedAt: z.string().datetime({ offset: true }),
    data: z.unknown(),
    resultFormat: z.enum(['json', 'qualitative']),
  })
  .strict();
const exhibitInputSchema = z
  .object({
    projectId: experimentIdSchema,
    experimentId: experimentIdSchema,
    attemptIndex: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    startedAt: z.string().datetime({ offset: true }).nullable(),
    sources: z.array(sourceSchema).max(100),
  })
  .strict();

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
  const parsed = exhibitInputSchema.safeParse(safeJson(input, true));
  error(parsed.success, 'Metrics sources require complete immutable provenance');
  const value = parsed.data;
  error(
    new Set(value.sources.map((source) => source.path)).size === value.sources.length,
    'Metrics sources must have unique paths',
  );
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
