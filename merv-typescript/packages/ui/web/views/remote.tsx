import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  UiAction,
  UiCollectionSpec,
  UiColumn,
  UiDetail,
  UiLivenessSpec,
  UiRecordSpec,
  UiSection,
} from '@merv/contracts/ui-manifest';
import { useTool } from '../api';
import {
  Ago,
  ConfirmAction,
  CopyButton,
  Countdown,
  Failure,
  KV,
  Live,
  LoadState,
  RecordPage,
  Table,
  col,
  cx,
  toneOf,
  useNow,
  words,
  type KVRow,
} from '../components';
import { ListPage, matches, splitRoutes, useListFilter } from '../list-filters';
import { elapsed, say, type Liveness } from '../liveness';
import { Markdown } from '../markdown';
import { useCommand } from '../mutations';
import { ProcessDiagram } from '../process';
import { firstSentence } from '../states';
import type { ViewProps } from './index';
import { at, list, money, num, phrase, records, str, unit, type Json } from './remote-fields';

/**
 * Rows a service outside this process publishes, rendered in Merv's own anatomy.
 * The manifest says what a row holds and never how it looks: the list keeps the
 * control row every collection has, the record keeps the order every record has,
 * and both speak the one vocabulary — state words, liveness phrases, clocks and
 * money — that the pages this process owns already speak. A field the service did
 * not send renders nothing, and the key is only ever a route and a prefix search.
 */
type States = UiCollectionSpec['states'];
interface Item {
  id: string;
  data: Json;
}
/** What every cell of one row reads from, whatever column it is. */
interface Facts {
  data: Json;
  states: States;
  now: number;
  /** True where the whole row is already a link, so a second anchor cannot nest in it. */
  linked?: boolean;
}

const ATTENTION = 'attention';

/** The state word with the dot vocabulary: colour reaches what failed and nothing else. */
function StateWord({ value, states }: { value: string; states: States }) {
  if (!value) return null;
  const failed = !!states?.failed?.includes(value);
  const live = !!states?.live?.includes(value);
  return (
    <span className={cx('status', failed && 'status--bad')}>
      {(failed || live || !!states?.open.includes(value)) && (
        <span className={cx('status-dot', live && 'remote-pulse')} aria-hidden="true" />
      )}
      {words(value)}
    </span>
  );
}

/** The service's own verdict, clause and clock, composed where every phrase is composed. */
function livenessOf(data: Json, spec: UiLivenessSpec | undefined, now: number): Liveness | null {
  const verdict = str(at(data, spec?.verdict));
  if (!spec || !verdict) return null;
  const tone = toneOf(verdict.toLowerCase());
  const clock = Date.parse(str(at(data, spec.clock)));
  return say(
    verdict,
    tone === 'neutral' ? 'dim' : tone,
    str(at(data, spec.clause)) || null,
    Number.isFinite(clock) ? `for ${elapsed(now - clock)}` : null,
  );
}

/** One column of one row, in the type the manifest gave it. */
function cell(column: UiColumn, { data, states, now, linked }: Facts): ReactNode {
  switch (column.type) {
    case 'name':
      return <strong>{str(at(data, column.field))}</strong>;
    case 'state':
      return <StateWord value={str(at(data, column.field))} states={states} />;
    case 'ago': {
      const value = str(at(data, column.field));
      return value ? <Ago at={value} className="muted" /> : null;
    }
    case 'countdown': {
      const granted = num(at(data, column.granted));
      return (
        <>
          <Countdown to={str(at(data, column.field)) || null} now={now} />
          {granted !== undefined && <span className="muted"> of {elapsed(granted * 1000)}</span>}
        </>
      );
    }
    case 'money':
      return money(data, column);
    case 'phrase':
      return <span className="muted">{phrase(data, column.fields, column.separator)}</span>;
    case 'link': {
      const link = at(data, column.field) as { name?: string; href?: string } | undefined;
      if (!link?.name) return null;
      return linked ? (
        <span className="muted">{link.name}</span>
      ) : (
        <a href={link.href}>{link.name}</a>
      );
    }
    default:
      return <span className="muted">{str(at(data, column.field))}</span>;
  }
}

/** The two column types that carry sentences get the room; the rest share what is left. */
const WIDTH: Record<string, string> = {
  name: 'minmax(0, 1.5fr)',
  phrase: 'minmax(0, 1.6fr)',
};

/** The columns on one grid, so a fact keeps its x-position down the whole list. */
function Columns({ columns, ...facts }: { columns: UiColumn[] } & Facts) {
  const template = columns
    .map((column) => column.width ?? WIDTH[column.type] ?? 'minmax(0, 1fr)')
    .join(' ');
  return (
    <span className="remote-cols" style={{ '--remote-cols': template } as CSSProperties}>
      {columns.map((column) => (
        <span
          className={cx('remote-cell', column.type === 'money' && 'remote-cell--end')}
          key={column.label}
          title={column.label}
        >
          {cell(column, facts)}
        </span>
      ))}
    </span>
  );
}

function CollectionList({ row }: ViewProps) {
  const spec = row.view.spec as UiCollectionSpec;
  const linked = !!row.view.record;
  const [every, setEvery] = useState(spec.cadence?.idleMs ?? 8000);
  const read = useTool<unknown>('ui.read', { rowId: row.id }, { every });
  const items: Item[] = records(read.data).map((data) => ({ id: str(at(data, spec.key)), data }));
  // The clocks and the cadence are for what is moving; a still list costs nothing.
  const when =
    spec.cadence?.liveWhen ??
    (spec.states?.live && { field: spec.states.field, in: spec.states.live });
  const running = !!when && items.some((item) => when.in.includes(str(at(item.data, when.field))));
  const now = useNow(running ? 1000 : 0);
  useEffect(() => {
    if (spec.cadence) setEvery(running ? spec.cadence.liveMs : spec.cadence.idleMs);
  }, [running, spec.cadence]);

  const labels = (item: Item) =>
    [spec.title, ...(spec.search ?? [])].map((field) => str(at(item.data, field)));
  const reason = (item: Item) => str(at(item.data, spec.attention?.field));
  const filter = useListFilter(items, {
    stateOf: spec.states && ((item) => str(at(item.data, spec.states!.field))),
    isOpen: spec.states && ((state) => spec.states!.open.includes(state)),
    labels,
    ids: (item) => [item.id],
  });
  // What needs a person is one more word on the state line, never a control of its own.
  const flagged = items.filter(reason);
  const search = filter.query.trim().toLowerCase();
  const rows =
    filter.state === ATTENTION
      ? items.filter(
          (item) =>
            item.id === filter.openId ||
            (!!reason(item) && matches(search, labels(item), [item.id])),
        )
      : [...filter.rows].sort((left, right) => Number(!!reason(right)) - Number(!!reason(left)));
  return (
    <ListPage
      load={read}
      noun={spec.noun.plural}
      // A published row names its own glyph; the empty list wears it as the rail does.
      kind={typeof row.view.icon === 'string' ? row.view.icon : undefined}
      filter={{
        ...filter,
        states: flagged.length
          ? [{ value: ATTENTION, count: flagged.length }, ...filter.states]
          : filter.states,
      }}
      rows={rows}
      opens={linked}
      columns={spec.columns.length}
      emptyTitle={spec.empty.title}
      line={(item) => ({
        name: (
          <Columns
            columns={spec.columns}
            data={item.data}
            states={spec.states}
            now={now}
            linked={linked}
          />
        ),
        standing: (
          <div className="remote-standing">
            <Live of={livenessOf(item.data, spec.liveness, now)} />
            {!!reason(item) && (
              <span className="remote-attn">{firstSentence(reason(item), 72)}</span>
            )}
          </div>
        ),
      })}
    />
  );
}

/** The one place machine text appears, and it is there to be copied, not read. */
const Copy = ({ text }: { text: string }) => (
  <>
    <span className="mono">{text}</span>
    <CopyButton text={text} />
  </>
);

const detailRow = (data: Json, detail: UiDetail): KVRow => {
  const value = at(data, detail.field);
  if (value === undefined || value === '') return null;
  return [detail.label, detail.mono ? <Copy text={str(value)} /> : unit(value, detail.unit)];
};

/** One control, bound to a tool this process registers; a guard names its consequence first. */
function Act({ action, id, onDone }: { action: UiAction; id: string; onDone(): void }) {
  const command = useCommand<unknown>({
    tool: action.tool,
    idempotent: true,
    validate: () => true,
    onSuccess: onDone,
  });
  const run = () => void command.submit({ id, ...action.args });
  return (
    <>
      {action.guard ? (
        <ConfirmAction
          label={action.label}
          title={action.guard.title}
          confirm={action.label}
          busy={command.busy ? 'Working…' : undefined}
          onConfirm={run}
        >
          <p>{action.guard.consequence}</p>
        </ConfirmAction>
      ) : (
        <button type="button" className="btn" disabled={command.locked} onClick={run}>
          {action.label}
        </button>
      )}
      <Failure message={command.error} />
    </>
  );
}

/** One section of a record, in the shape its kind names: a paragraph, rows, a table, a ladder. */
function Section({ section, ...facts }: { section: UiSection } & Facts) {
  const { data, states, now } = facts;
  // A service writes its prose the way an agent writes a brief, so it is read the same way.
  if (section.kind === 'text') return <Markdown source={str(at(data, section.field))} />;
  if (section.kind === 'kv')
    return <KV rows={section.rows.map((detail) => detailRow(data, detail))} />;
  const items = list(at(data, section.field));
  if (section.kind === 'list')
    return (
      <Table
        rows={items}
        keyOf={(item) => String(items.indexOf(item))}
        columns={section.columns.map((column, index) =>
          col<Json>(
            String(index),
            column.label,
            (item) => cell(column, { data: item, states, now }),
            column.width,
          ),
        )}
      />
    );
  // A ladder is a process read as steps, so it is drawn as one: each step to the next.
  return (
    <ProcessDiagram
      steps={items.map((step, index) => ({
        state: str(at(step, section.step)),
        end: index === items.length - 1,
        stopped: false,
        current: str(at(step, section.state)) === 'here',
        entered: str(at(step, section.state)) !== 'next',
      }))}
      ways={items.slice(1).map((_, index) => ({ from: index, to: index + 1, taken: false }))}
    />
  );
}

export function RemoteRecord({ row }: ViewProps) {
  const collection =
    row.view.kind === 'collection' ? (row.view.spec as UiCollectionSpec) : undefined;
  const spec = (row.view.record ?? row.view.spec) as UiRecordSpec | undefined;
  const { id = '' } = useParams();
  const read = useTool<Json>('ui.read', { rowId: row.id, params: { id } }, { every: 8000 });
  const now = useNow(4000);
  const data = read.data;
  if (!spec || !data)
    return (
      <div className="page-stage">
        <LoadState {...read} back={{ to: row.path, label: row.label }} />
      </div>
    );
  const noun = collection?.noun.singular ?? row.label;
  const facts: Facts = { data, states: collection?.states, now };
  // A section the service did not fill is dropped where it is written, never drawn empty.
  const has = (section: UiSection) =>
    section.kind === 'kv'
      ? section.rows.some((detail) => at(data, detail.field) !== undefined)
      : section.kind === 'text'
        ? !!str(at(data, section.field))
        : list(at(data, section.field)).length > 0;
  const titled = (section: UiSection) => (
    <Fragment key={section.title}>
      <h3 className="ev-role">{section.title}</h3>
      <Section section={section} {...facts} />
    </Fragment>
  );
  const standing = livenessOf(data, spec.standing, now);
  const state = str(at(data, spec.state));
  const history = (spec.history ?? []).filter(has);
  const details = (spec.details ?? []).map((detail) => detailRow(data, detail)).filter(Boolean);
  const actions = (spec.act ?? []).filter(
    (action) => !action.when || action.when.in.includes(str(at(data, action.when.field))),
  );
  const out = spec.console && consoleHref(spec.console.href, id, str(at(data, 'console_origin')));
  return (
    <RecordPage
      back={<Link to={row.path}>← {row.label}</Link>}
      kind={noun}
      name={str(at(data, spec.title)) || noun}
      standing={standing ? <Live of={standing} /> : undefined}
      state={state ? <StateWord value={state} states={collection?.states} /> : undefined}
      act={
        actions.length || out ? (
          <div className="stack">
            {actions.map((action) => (
              <Act key={action.id} action={action} id={id} onDone={read.reload} />
            ))}
            {out && (
              <a className="agent-help" href={out} target="_blank" rel="noreferrer">
                {spec.console!.label} →
              </a>
            )}
          </div>
        ) : undefined
      }
      title={spec.content?.title ?? ''}
      content={
        spec.content && has(spec.content) ? (
          <Section section={spec.content} {...facts} />
        ) : undefined
      }
      history={history.length ? history.map(titled) : undefined}
      related={spec.related && has(spec.related) ? titled(spec.related) : undefined}
      details={details.length ? <KV rows={details} /> : undefined}
    />
  );
}

/** The one link out: the key substituted, and a relative href resolved where the service said. */
function consoleHref(href: string, id: string, origin: string): string {
  const path = href.replaceAll('{id}', encodeURIComponent(id));
  if (!origin || /^[a-z]+:/i.test(path)) return path;
  try {
    return new URL(path, origin).toString();
  } catch {
    return path;
  }
}

/** A collection row: its list, and the record it opens beside it on a wide screen. */
export const CollectionView = splitRoutes(CollectionList, RemoteRecord);
/** A row that is one record rather than a collection. */
export const RecordView = RemoteRecord;
