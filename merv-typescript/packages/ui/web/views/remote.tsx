import { type CSSProperties, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  UiAction,
  UiCollectionSpec,
  UiColumn,
  UiDetail,
  UiLivenessSpec,
  UiRecordSpec,
} from '@merv/ui/manifest';
import { useTool } from '../api';
import {
  Ago,
  ConfirmAction,
  CopyButton,
  Countdown,
  Failure,
  KV,
  Live,
  PageLoad,
  RecordPage,
  cx,
  toneOf,
  useNow,
  words,
  type KVRow,
} from '../components';
import { ListPage, matches, splitRoutes, useListFilter } from '../list-filters';
import { elapsed, say, type Liveness } from '../liveness';
import { useCommand } from '../mutations';
import { firstSentence } from '@merv/contracts/text';
import type { ViewProps } from './index';
import { at, records, str, unit, type Json } from './remote-fields';

/**
 * Rows a service outside this process publishes, rendered in Merv's own anatomy.
 * The manifest says what a row holds and never how it looks: the list keeps the
 * control row every collection has, the record keeps the order every record has,
 * and both speak the one vocabulary — state words, liveness phrases and clocks —
 * that the pages this process owns already speak. A field the service did
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
function cell(column: UiColumn, { data, states, now }: Facts): ReactNode {
  const value = str(at(data, column.field));
  switch (column.type) {
    case 'name':
      return <strong>{value}</strong>;
    case 'state':
      return <StateWord value={value} states={states} />;
    case 'ago':
      return value ? <Ago at={value} className="muted" /> : null;
    case 'countdown':
      return <Countdown to={value || null} now={now} />;
  }
}

/** The columns on one grid, so a fact keeps its x-position down the whole list. */
function Columns({ columns, ...facts }: { columns: UiColumn[] } & Facts) {
  // The name carries a sentence and gets the room; the rest share what is left.
  const template = columns
    .map((column) => (column.type === 'name' ? 'minmax(0, 1.5fr)' : 'minmax(0, 1fr)'))
    .join(' ');
  return (
    <span className="remote-cols" style={{ '--remote-cols': template } as CSSProperties}>
      {columns.map((column) => (
        <span className="remote-cell" key={column.label} title={column.label}>
          {cell(column, facts)}
        </span>
      ))}
    </span>
  );
}

function CollectionList({ row }: ViewProps) {
  const spec = row.view.spec as UiCollectionSpec;
  const linked = !!row.view.record;
  // The clocks and the cadence are for what is moving; a still list costs nothing.
  const when =
    spec.cadence?.liveWhen ??
    (spec.states?.live && { field: spec.states.field, in: spec.states.live });
  const moving = (data: unknown) =>
    !!when && records(data).some((item) => when.in.includes(str(at(item, when.field))));
  const read = useTool<unknown>(
    'ui.read',
    { rowId: row.id },
    {
      every: (data) =>
        !spec.cadence ? 8000 : moving(data) ? spec.cadence.liveMs : spec.cadence.idleMs,
    },
  );
  const items: Item[] = records(read.data).map((data) => ({ id: str(at(data, spec.key)), data }));
  const running = moving(read.data);
  const now = useNow(running ? 1000 : 0);

  const labels = (item: Item) =>
    [spec.title, ...(spec.search ?? [])].map((field) => str(at(item.data, field)));
  // A row that has ended needs nobody, whatever its last error said.
  const reason = (item: Item) =>
    spec.states && !spec.states.open.includes(str(at(item.data, spec.states.field)))
      ? ''
      : str(at(item.data, spec.attention?.field));
  const filter = useListFilter(items, {
    stateOf: spec.states && ((item) => str(at(item.data, spec.states!.field))),
    isOpen: spec.states && ((state) => spec.states!.open.includes(state)),
    labels,
    ids: (item) => [item.id],
    history: true,
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
        name: <Columns columns={spec.columns} data={item.data} states={spec.states} now={now} />,
        standing: (
          <div className="remote-standing">
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
    // Published tools do not accept requestId; an unknown result must be checked by reading.
    idempotent: true,
    validate: () => true,
    onSuccess: onDone,
  });
  const run = () => void command.submit({ id, ...action.args });
  return (
    <>
      {command.retry ? (
        <button type="button" className="btn" onClick={() => location.reload()}>
          Refresh page
        </button>
      ) : action.guard ? (
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
        <button type="button" className="btn" disabled={command.busy} onClick={run}>
          {action.label}
        </button>
      )}
      <Failure
        message={
          command.retry
            ? 'The result is unknown. Refresh the page and check the updated record before performing this action again.'
            : command.error
        }
      />
    </>
  );
}

/** One record of a collection row. */
export function RemoteRecord({ row }: ViewProps) {
  const collection = row.view.spec as UiCollectionSpec;
  const spec = row.view.record as UiRecordSpec | undefined;
  const { id = '' } = useParams();
  const read = useTool<Json>('ui.read', { rowId: row.id, params: { id } }, { every: 8000 });
  const now = useNow(4000);
  const data = read.data;
  if (!spec || !data) return <PageLoad {...read} back={{ to: row.path, label: row.label }} />;
  const noun = collection.noun.singular;
  const standing = livenessOf(data, spec.standing, now);
  const state = str(at(data, spec.state));
  const details = (spec.details ?? []).map((detail) => detailRow(data, detail)).filter(Boolean);
  const actions = (spec.act ?? []).filter(
    (action) => !action.when || action.when.in.includes(str(at(data, action.when.field))),
  );
  return (
    <RecordPage
      back={<Link to={row.path}>← {row.label}</Link>}
      kind={noun}
      name={str(at(data, spec.title)) || noun}
      standing={standing ? <Live of={standing} /> : undefined}
      state={state ? <StateWord value={state} states={collection.states} /> : undefined}
      act={
        actions.length ? (
          <div className="stack">
            {actions.map((action) => (
              <Act key={action.id} action={action} id={id} onDone={read.reload} />
            ))}
          </div>
        ) : undefined
      }
      details={details.length ? <KV rows={details} /> : undefined}
    />
  );
}

/** A collection row: its list, and the record it opens beside it on a wide screen. */
export const CollectionView = splitRoutes(CollectionList, RemoteRecord);
