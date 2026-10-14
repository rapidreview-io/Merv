// The chart grammar agents write: a small layered grammar compiled to Vega-Lite. Colours and
// sizes are named by meaning (roles, steps); the theme, fonts, legends and titles belong to the
// renderer and cannot be set.

export const ROLES = {
  result: '#2449D8',
  warn: '#C2410C',
  baseline: '#A9A9A4',
  muted: '#CFCFCB',
  ink: '#111113',
} as const;
export type Role = keyof typeof ROLES;
const MARKS = ['point', 'bar', 'line', 'area', 'rule', 'text', 'tick'];
const TOP_KEYS = ['id', 'message', 'data', 'x', 'y', 'layer', 'height', 'wide'];
const LAYER_KEYS = [
  'mark',
  'data',
  'x',
  'x2',
  'y',
  'y2',
  'color',
  'size',
  'style',
  'text',
  'where',
  'emphasis',
  'align',
  'offset',
];
const CHANNEL_KEYS = [
  'field',
  'type',
  'title',
  'domain',
  'zero',
  'sort',
  'ticks',
  'axis',
  'value',
  'datum',
  'format',
];
const WHERE_OPS = ['equal', 'oneOf', 'gt', 'gte', 'lt', 'lte', 'notEqual'];
const STEPS = ['s', 'm', 'l'];
export const MAX_LAYERS = 6;

const POINT_AREA = { s: 30, m: 70, l: 120 };
const STROKE = { s: 1, m: 2, l: 4 };
const FONT = { s: 10, m: 11, l: 13 };
const BAR = { s: 6, m: 10, l: 16 };
const ROW = { s: 28, m: 40, l: 56 };
const PLOT = { s: 90, m: 130, l: 180 };
/** A continuous chart may grow to this multiple of its base height to fill the page. */
export const ELASTIC = 1.8;

type Step = 's' | 'm' | 'l';
export type Row = Record<string, unknown>;
/** Data a chart names, resolved by the caller: report files by path, artifacts by `artifact:<id>`. */
export type DataFiles = ReadonlyMap<string, string>;
export interface Issue {
  level: 'error' | 'warning';
  where?: string;
  message: string;
}
export interface DataRef {
  values?: Row[];
  file?: string;
  artifact?: string;
}
// The spec is agent JSON, validated by validateSpec before any other use.
export type ChartSpec = Record<string, any>;

/** Validate an agent-written spec. */
export function validateSpec(spec: unknown): Issue[] {
  const issues: Issue[] = [];
  const err = (message: string) => issues.push({ level: 'error', message });
  if (!spec || typeof spec !== 'object' || Array.isArray(spec))
    return [{ level: 'error', message: 'chart must be a JSON object' }];
  const s = spec as ChartSpec;
  if (/#[0-9a-f]{3,8}\b/i.test(JSON.stringify(s)))
    err('hex colours are not allowed; use a role: ' + Object.keys(ROLES).join(', '));
  unknown(s, TOP_KEYS, 'chart', err);
  if (typeof s.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(s.id))
    err('id must be lower-case letters, digits and dashes');
  if (typeof s.message !== 'string' || !s.message.trim())
    err('message is required: the one sentence this chart must make obvious');
  else if (words(s.message) > 25) err('message is longer than 25 words');
  checkData(s.data, 'data', err, true);
  if (s.height !== undefined && !STEPS.includes(s.height)) err('height must be s, m or l');
  if (s.wide !== undefined && typeof s.wide !== 'boolean') err('wide must be true or false');
  for (const ch of ['x', 'y']) if (s[ch] !== undefined) checkChannel(s[ch], ch, err);
  if (!Array.isArray(s.layer) || !s.layer.length) err('layer must be a non-empty list');
  else {
    if (s.layer.length > MAX_LAYERS) err(`at most ${MAX_LAYERS} layers`);
    s.layer.forEach((layer: unknown, i: number) => checkLayer(layer, `layer[${i}]`, err));
  }
  return issues;
}

function checkLayer(layer: any, at: string, err: (m: string) => void): void {
  if (!layer || typeof layer !== 'object') return err(`${at} must be an object`);
  unknown(layer, LAYER_KEYS, at, err);
  if (!MARKS.includes(layer.mark)) err(`${at}.mark must be one of ${MARKS.join(', ')}`);
  if (layer.data !== undefined) checkData(layer.data, `${at}.data`, err, false);
  for (const ch of ['x', 'x2', 'y', 'y2'])
    if (layer[ch] !== undefined) checkChannel(layer[ch], `${at}.${ch}`, err);
  if (layer.color !== undefined) {
    const c = layer.color;
    if (typeof c === 'string') {
      if (!(c in ROLES)) err(`${at}.color: unknown role "${c}"`);
    } else if (
      c &&
      typeof c === 'object' &&
      typeof c.field === 'string' &&
      c.map &&
      typeof c.map === 'object'
    ) {
      for (const role of Object.values(c.map))
        if (typeof role !== 'string' || !(role in ROLES))
          err(`${at}.color.map: unknown role "${String(role)}"`);
      unknown(c, ['field', 'map'], `${at}.color`, err);
    } else err(`${at}.color must be a role name or {field, map: {value: role}}`);
  }
  if (layer.size !== undefined && !STEPS.includes(layer.size)) err(`${at}.size must be s, m or l`);
  if (layer.style !== undefined && !['solid', 'dashed'].includes(layer.style))
    err(`${at}.style must be solid or dashed`);
  if (layer.emphasis !== undefined && !['low', 'normal'].includes(layer.emphasis))
    err(`${at}.emphasis must be low or normal`);
  if (layer.align !== undefined && !['left', 'center', 'right'].includes(layer.align))
    err(`${at}.align must be left, center or right`);
  if (
    layer.offset !== undefined &&
    !(
      Array.isArray(layer.offset) &&
      layer.offset.length === 2 &&
      layer.offset.every((n: unknown) => typeof n === 'number' && Math.abs(n) <= 40)
    )
  )
    err(`${at}.offset must be [dx, dy] in pixels, each within ±40`);
  if (layer.text !== undefined) {
    const t = layer.text;
    const ok =
      typeof t === 'string' ||
      (t && typeof t === 'object' && (typeof t.value === 'string' || typeof t.field === 'string'));
    if (!ok) err(`${at}.text must be a field name, {field, format} or {value}`);
    if (layer.mark !== 'text') err(`${at}.text only applies to text marks`);
  }
  if (layer.mark === 'text' && layer.text === undefined) err(`${at}: text marks need text`);
  if (layer.where !== undefined) {
    const w = layer.where;
    const ops = w && typeof w === 'object' ? Object.keys(w).filter((k) => k !== 'field') : [];
    if (!w || typeof w.field !== 'string' || ops.length !== 1 || !WHERE_OPS.includes(ops[0]))
      err(`${at}.where must be {field, <${WHERE_OPS.join('|')}>: value}`);
  }
}

function checkChannel(ch: any, at: string, err: (m: string) => void): void {
  if (typeof ch === 'string') return;
  if (!ch || typeof ch !== 'object') return err(`${at} must be a field name or an object`);
  unknown(ch, CHANNEL_KEYS, at, err);
  if (
    ch.type !== undefined &&
    !['quantitative', 'nominal', 'ordinal', 'temporal'].includes(ch.type)
  )
    err(`${at}.type is invalid`);
  if (
    ch.value !== undefined &&
    !(typeof ch.value === 'number' || ['start', 'end'].includes(ch.value))
  )
    err(`${at}.value must be a number, "start" or "end"`);
  if (ch.ticks !== undefined && !Array.isArray(ch.ticks)) err(`${at}.ticks must be a list`);
  if (ch.domain !== undefined && !(Array.isArray(ch.domain) && ch.domain.length >= 2))
    err(`${at}.domain must be a list`);
  if (ch.axis !== undefined && typeof ch.axis !== 'boolean')
    err(`${at}.axis must be true or false`);
}

function checkData(data: any, at: string, err: (m: string) => void, required: boolean): void {
  if (data === undefined) {
    if (required)
      err(`${at} is required: {values: [...]}, {file: "name.csv"} or {artifact: "<artifact id>"}`);
    return;
  }
  if (!data || typeof data !== 'object') return err(`${at} must be {values}, {file} or {artifact}`);
  unknown(data, ['values', 'file', 'artifact'], at, err);
  const sources = ['values', 'file', 'artifact'].filter((k) => data[k] !== undefined);
  if (sources.length !== 1) err(`${at} needs exactly one of values, file or artifact`);
  if (data.values !== undefined && !Array.isArray(data.values))
    err(`${at}.values must be a list of rows`);
  if (data.file !== undefined && !/^[\w.-]+\.(csv|json)$/.test(data.file))
    err(`${at}.file must name a report file ending .csv or .json`);
  if (data.artifact !== undefined && (typeof data.artifact !== 'string' || !data.artifact.trim()))
    err(`${at}.artifact must be an artifact id`);
}

function unknown(
  obj: Record<string, unknown>,
  allowed: string[],
  at: string,
  err: (m: string) => void,
): void {
  for (const key of Object.keys(obj))
    if (!allowed.includes(key))
      err(`${at}: "${key}" is not allowed (allowed: ${allowed.join(', ')})`);
}

export function words(text: string): number {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

export interface Criterion {
  metric: string;
  bar?: number;
  floor?: number;
}

/** Every data reference a chart makes, as keys of the files map. */
export function dataKeys(spec: ChartSpec): string[] {
  const refs = [
    spec.data,
    ...(Array.isArray(spec.layer) ? spec.layer.map((l: any) => l?.data) : []),
  ];
  return refs.flatMap((d: DataRef | undefined) =>
    d?.file ? [d.file] : d?.artifact ? [`artifact:${d.artifact}`] : [],
  );
}

/** Rows for a data reference; adds status and bar fields from pre-registered criteria. */
export function loadRows(data: DataRef, files: DataFiles, criteria: Criterion[] = []): Row[] {
  let rows: Row[];
  if (data.values) rows = data.values.map((r) => ({ ...r }));
  else {
    const key = data.file ?? `artifact:${data.artifact}`;
    const text = files.get(key);
    if (text === undefined) throw new Error(`data ${data.file ?? data.artifact} is missing`);
    const json = data.file ? data.file.endsWith('.json') : /^\s*[[{]/.test(text);
    if (json) {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed))
        throw new Error(`data ${data.file ?? data.artifact} must be a JSON list of rows`);
      rows = parsed as Row[];
    } else rows = parseCsv(text);
  }
  return applyCriteria(rows, criteria);
}

export function parseCsv(text: string): Row[] {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(',').map((s) => s.trim());
  return lines.filter(Boolean).map((line) => {
    const cells = line.split(',');
    const row: Row = {};
    cols.forEach((c, i) => {
      const v = (cells[i] ?? '').trim();
      row[c] = v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
    });
    return row;
  });
}

// The renderer, not the agent, decides whether a result met its bar.
function applyCriteria(rows: Row[], criteria: Criterion[]): Row[] {
  if (!criteria.length) return rows;
  return rows.map((row) => {
    const c = criteria.find((k) => k.metric === row.metric);
    if (!c || typeof row.delta !== 'number') return row;
    if (c.bar !== undefined)
      return { ...row, bar: c.bar, status: row.delta >= c.bar ? 'met' : 'not met' };
    if (c.floor !== undefined)
      return { ...row, bar: c.floor, status: row.delta >= c.floor ? 'held' : 'breached' };
    return row;
  });
}

function inferType(rows: Row[], field: string): string {
  const v = rows.find((r) => r[field] !== undefined && r[field] !== '')?.[field];
  if (typeof v === 'number') return 'quantitative';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(v)) return 'temporal';
  return 'nominal';
}

/** Base and maximum plot height. Category charts keep their row height; only continuous ones grow. */
export function chartHeights(spec: ChartSpec, rows: Row[]): { base: number; max: number } {
  const step: Step = spec.height ?? 'm';
  const yField = typeof spec.y === 'string' ? spec.y : spec.y?.field;
  if (yField && inferType(rows, yField) === 'nominal') {
    const n = new Set(rows.map((r) => r[yField])).size || 1;
    const base = n * ROW[step] + 24;
    return { base, max: base };
  }
  return { base: PLOT[step], max: Math.round(PLOT[step] * ELASTIC) };
}

const THEME = {
  font: 'Geist',
  background: null,
  view: { stroke: null },
  padding: 0,
  axis: {
    domain: false,
    ticks: false,
    grid: false,
    labelFont: 'Geist Mono',
    labelFontSize: 10,
    labelColor: '#6B6B70',
    labelPadding: 6,
    titleFont: 'Geist Mono',
    titleFontSize: 10,
    titleColor: '#6B6B70',
    titleFontWeight: 400,
    titlePadding: 6,
  },
  axisX: { titleAnchor: 'end' },
  axisY: { titleAnchor: 'end', titleAngle: 0, titleAlign: 'left', titleY: -8, titleX: 0 },
  axisBand: {
    labelFont: 'Geist',
    labelFontSize: 13,
    labelColor: '#111113',
    labelFontWeight: 500,
    labelPadding: 12,
    labelLimit: 220,
  },
  legend: { disable: true },
  mark: { color: ROLES.ink },
  point: { filled: true },
  line: { strokeWidth: 1.75, strokeCap: 'round', strokeJoin: 'round' },
  text: { font: 'Geist Mono', fontSize: 11, color: ROLES.ink },
  bar: { cornerRadius: 2 },
};

type Channel = { field?: string; type?: string; [k: string]: any };

/** Compile to a Vega-Lite spec at a fixed pixel size. */
export function compileSpec(
  spec: ChartSpec,
  {
    width,
    height,
    files,
    criteria,
  }: { width: number; height: number; files: DataFiles; criteria: Criterion[] },
): Record<string, unknown> {
  const rows = loadRows(spec.data, files, criteria);
  const top = { x: norm(spec.x, rows), y: norm(spec.y, rows) };
  const firstField: Record<string, number> = {};
  spec.layer.forEach((layer: any, i: number) => {
    for (const ch of ['x', 'y'] as const) {
      const d = layer[ch] !== undefined ? norm(layer[ch], rows) : top[ch];
      if (d?.field && firstField[ch] === undefined) firstField[ch] = i;
    }
  });
  const layers = spec.layer.map((layer: any, i: number) => {
    const lrows = layer.data ? loadRows(layer.data, files, criteria) : null;
    const src = lrows ?? rows;
    const mark: Record<string, unknown> = { type: layer.mark };
    const enc: Record<string, unknown> = {};
    for (const ch of ['x', 'y'] as const) {
      const own = layer[ch] !== undefined ? norm(layer[ch], src) : null;
      const def = own ?? top[ch];
      if (!def) continue;
      enc[ch] = encodeChannel(def, ch, top[ch], firstField[ch] === i);
    }
    for (const ch of ['x2', 'y2'])
      if (layer[ch] !== undefined) {
        const d = norm(layer[ch], src)!;
        enc[ch] = d.field ? { field: d.field } : valueOf(d, ch);
      }
    const size: Step = layer.size ?? 'm';
    if (layer.mark === 'point') mark.size = POINT_AREA[size];
    if (['rule', 'line', 'tick'].includes(layer.mark)) mark.strokeWidth = STROKE[size];
    if (layer.mark === 'tick') mark.thickness = STROKE[size];
    if (layer.mark === 'bar') mark.size = BAR[size];
    if (layer.mark === 'text') mark.fontSize = FONT[size];
    if (layer.style === 'dashed') mark.strokeDash = [5, 3];
    if (layer.emphasis === 'low') mark.opacity = 0.4;
    if (layer.align) mark.align = layer.align;
    if (layer.offset) {
      mark.dx = layer.offset[0];
      mark.dy = layer.offset[1];
    }
    if (layer.mark === 'text') {
      mark.baseline = 'middle';
      const t = layer.text;
      if (typeof t === 'string') enc.text = { field: t };
      else if (t.field) enc.text = { field: t.field, ...(t.format ? { format: t.format } : {}) };
      else mark.text = t.value;
    }
    const c = layer.color;
    if (typeof c === 'string') mark.color = ROLES[c as Role];
    else if (c)
      enc.color = {
        field: c.field,
        scale: {
          domain: Object.keys(c.map),
          range: Object.values(c.map).map((r) => ROLES[r as Role]),
        },
        legend: null,
      };
    const out: Record<string, unknown> = { mark, encoding: enc };
    if (lrows) out.data = { values: lrows };
    // A layer placed only by fixed values draws once, not once per data row.
    const usesField = Object.values(enc).some((e) => e && typeof e === 'object' && 'field' in e);
    if (!usesField && !lrows) out.data = { values: [{}] };
    if (layer.where) {
      const { field, ...op } = layer.where;
      out.transform = [{ filter: { field, ...op } }];
    }
    return out;
  });
  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    width,
    height,
    autosize: { type: 'fit', contains: 'padding' },
    data: { values: rows },
    config: THEME,
    layer: layers,
    resolve: { scale: { color: 'independent' } },
  };
}

function norm(ch: unknown, rows: Row[]): Channel | null {
  if (ch === undefined || ch === null) return null;
  const d: Channel = typeof ch === 'string' ? { field: ch } : { ...(ch as Channel) };
  if (d.field && !d.type) d.type = inferType(rows, d.field);
  return d;
}

function valueOf(d: Channel, ch: string): Record<string, unknown> {
  if (d.datum !== undefined) return { datum: d.datum };
  if (d.value === 'end') return { value: ch.startsWith('x') ? 'width' : 0 };
  if (d.value === 'start') return { value: ch.startsWith('x') ? 0 : 'height' };
  return { value: d.value };
}

function encodeChannel(
  def: Channel,
  ch: string,
  topDef: Channel | null,
  primary: boolean,
): Record<string, unknown> {
  if (!def.field) return valueOf(def, ch);
  const shared: Channel = topDef ?? {};
  const e: Record<string, unknown> = { field: def.field, type: def.type };
  const scale: Record<string, unknown> = {};
  const domain = def.domain ?? shared.domain;
  const zero = def.zero ?? shared.zero;
  // A time axis takes its range as dates; Vega-Lite wants them as timestamps.
  if (domain)
    scale.domain =
      def.type === 'temporal'
        ? domain.map((d: unknown) => (typeof d === 'string' ? Date.parse(d) : d))
        : domain;
  if (zero !== undefined) scale.zero = zero;
  if (def.type === 'nominal' || def.type === 'ordinal') {
    e.sort = def.sort ?? shared.sort ?? null;
    scale.paddingInner = 0.3;
  }
  if (def.type === 'temporal' || def.type === 'quantitative') scale.nice = false;
  if (Object.keys(scale).length) e.scale = scale;
  if (shared.axis === false || def.axis === false) e.axis = null;
  else if (!primary) e.title = shared.title ?? null;
  else {
    const axis: Record<string, unknown> = { title: shared.title ?? def.title ?? null };
    const ticks = shared.ticks ?? def.ticks;
    const format = shared.format ?? def.format;
    if (ticks) axis.values = ticks;
    if (format) axis.format = format;
    if (def.type === 'quantitative' && !ticks) axis.tickCount = 5;
    if (def.type === 'temporal' || def.type === 'quantitative') axis.labelOverlap = true;
    e.axis = axis;
  }
  return e;
}
