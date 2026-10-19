import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AdminCredits, CreditUse, PersonCredits } from '@merv/admin/models';
import { useTool } from '../api';
import {
  ConfirmAction,
  Failure,
  Field,
  LoadState,
  OpenedForm,
  Ruled,
  Submit,
  Word,
  col,
  cx,
  stamp,
  useHeadFocus,
  useSidebarEscape,
  type Column,
} from '../components';
import { ListPage, Segments, openRow, typing, useListFilter } from '../list-filters';
import { day } from '../session';
import { useRoomy } from '../theme';
import { Head, None, count, fig, usePost } from './parts';
import { usd } from '../views/remote-fields';

/** A row: the person, under the id a list filter keys it by (their `issuer|subject`). */
type Person = AdminCredits['people'][number] & { id: string };
type Today = Person['kinds'][number];
const WINDOWS = [
  { value: 'day', label: '1D' },
  { value: 'week', label: '1W' },
  { value: 'month', label: '1M' },
  { value: 'total', label: 'Total' },
] as const;
type Span = (typeof WINDOWS)[number]['value'];

/** A figure in its type's unit: dollars, or a count of tokens. */
const amount = (unit: CreditUse['unit'], n: number | null) =>
  n === null ? <None /> : unit === 'usd' ? usd(n) : count(n);
/** What is left of a type's limit, today's or a provider's grants, of it faint; red at none. */
function today(use?: Today) {
  if (!use || !use.limit || use.left === null) return null;
  return (
    <span className={cx('admin-of', use.left <= 0 && 'status--bad')}>
      <span className="admin-left">{amount(use.unit, use.left)}</span>{' '}
      <span className="faint">of {amount(use.unit, use.limit)}</span>
    </span>
  );
}
/** A day, with its minute in the hover title. */
const when = (at: string | null) =>
  at && (
    <time dateTime={at} title={stamp(at)}>
      {day(at)}
    </time>
  );

/** What ⋯ on a grant or a schedule asks for: its verb, what it names, and the POST that does it. */
type Act = { id: string; verb: string; says: string; path: string; body?: Record<string, unknown> };
function Guard({ act, close, done }: { act: Act; close(): void; done(): void }) {
  const command = usePost(() => (close(), done()));
  return (
    <ConfirmAction
      opened
      label={act.verb}
      title={`${act.verb}?`}
      confirm={act.verb}
      busy={command.busy ? 'Working…' : undefined}
      note={<Failure message={command.error} />}
      onToggle={(open) => !open && close()}
      onConfirm={() => command.submit({ path: act.path, ...act.body })}
    >
      <p>{act.says}</p>
    </ConfirmAction>
  );
}

/** A platform kind's own daily limit for this person, or the default again (`Clear`). */
function LimitForm(props: { use: CreditUse; person: string; close(): void; done(): void }) {
  const { use, close } = props;
  const [value, setValue] = useState(use.own && use.limit !== null ? String(use.limit) : '');
  // Any answer the route confirms is the change: it names no record of its own.
  const command = usePost(
    () => (close(), props.done()),
    () => true,
  );
  const path = `/admin/credits/people/${encodeURIComponent(props.person)}/limits`;
  const send = (limit: number | null) => void command.submit({ path, kind: use.kind, limit });
  return (
    <OpenedForm
      className="stack entry-form"
      onClose={close}
      locked={command.locked}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        send(Number(value));
      }}
      aria-label={`Set limit · ${use.label}`}
    >
      <fieldset disabled={command.locked}>
        <Field
          label={use.unit === 'usd' ? 'Dollars a day' : 'Tokens a day'}
          className="tabular"
          type="number"
          {...(use.unit === 'usd'
            ? { min: 0.01, max: 100_000, step: 0.01 }
            : { min: 1, max: 1_000_000_000, step: 1 })}
          required
          value={value}
          onChange={setValue}
        />
      </fieldset>
      <div className="cluster">
        <Submit label="Save" busy={command.busy} retry={command.retry} />
        {use.own && (
          <button
            type="button"
            className="btn"
            disabled={command.locked}
            onClick={() => send(null)}
          >
            Clear
          </button>
        )}
      </div>
      <Failure message={command.error} />
    </OpenedForm>
  );
}

/** Provider credit for this person: a grant on their own account now, or a schedule of grants. */
function GiveForm(props: { provider: string; of: PersonCredits; close(): void; done(): void }) {
  const { provider, of, close } = props;
  const [form, setForm] = useState({ amount: '', cadence: 'once', until: '', reason: '' });
  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (value: string) => setForm({ ...form, [key]: value }),
  });
  const once = form.cadence === 'once';
  const command = usePost(() => (close(), props.done()));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    // The grant's own id is its idempotency key, made once per submission and kept for a retry.
    const terms = { id: crypto.randomUUID(), provider, amount: form.amount.trim() };
    const at = new Date().toISOString();
    const end = form.until ? new Date(form.until).toISOString() : null;
    void command.submit(
      once
        ? {
            path: '/admin/credits/grants',
            ...terms,
            person: of.person.key,
            validFrom: at,
            expiresAt: end,
            reason: form.reason,
          }
        : {
            path: '/admin/credits/schedules',
            ...terms,
            person: of.person.key,
            cadence: form.cadence,
            startsAt: at,
            validityPeriods: 1,
            endsAt: end,
            enabled: true,
          },
    );
  };
  return (
    <OpenedForm
      className="stack entry-form"
      onClose={close}
      locked={command.locked}
      onSubmit={submit}
      aria-label={`Give credit · ${provider}`}
    >
      <fieldset disabled={command.locked}>
        <Field
          label="Amount"
          className="tabular"
          inputMode="decimal"
          required
          pattern="\s*\d+(\.\d{1,6})?\s*"
          placeholder="0.00"
          {...field('amount')}
        />
        <label>
          Repeats
          <select {...field('cadence')} onChange={(e) => field('cadence').onChange(e.target.value)}>
            {['once', 'daily', 'weekly', 'monthly'].map((cadence) => (
              <option key={cadence}>{cadence}</option>
            ))}
          </select>
        </label>
        <Field label={once ? 'Expires' : 'Ends'} type="datetime-local" {...field('until')} />
        {once && <Field label="Reason" required maxLength={2000} {...field('reason')} />}
      </fieldset>
      {/* Outside the fields it locks, so a request kept for a retry can be sent again. */}
      <div>
        <Submit label="Give" busy={command.busy} retry={command.retry} saving="Giving…" />
      </div>
      <Failure message={command.error} />
    </OpenedForm>
  );
}

type Grant = PersonCredits['grants'][number];

/** One credit type: what was used in the window, what is left of its limit, and its control. */
function Use(props: { use: CreditUse; span: Span; of: PersonCredits; done(): void }) {
  const { use, of, done } = props;
  const [open, setOpen] = useState(false);
  const [acting, setActing] = useState<Act>();
  const provider = use.kind.startsWith('provider:') ? use.kind.slice('provider:'.length) : null;
  const shown = (n: number | null) => amount(use.unit, n);
  const share = use.limit && use.left !== null ? Math.min(1, Math.max(0, use.left / use.limit)) : 0;
  const now = new Date().toISOString();
  const over = (g: Grant) =>
    g.revoked_at ? 'revoked' : g.expires_at && g.expires_at < now ? 'expired' : undefined;
  const more = (asked: Act | false) =>
    asked && (
      <button
        type="button"
        className="btn-icon btn-icon--inline file-menu-open admin-more"
        aria-label={asked.verb}
        title={asked.verb}
        aria-expanded={acting?.id === asked.id}
        onClick={() => setActing(acting?.id === asked.id ? undefined : asked)}
      >
        ⋯
      </button>
    );
  const guard = (id: string) =>
    acting?.id === id && <Guard act={acting} close={() => setActing(undefined)} done={done} />;
  const grants = provider ? of.grants.filter((g) => g.provider === provider) : [];
  const schedules = provider ? of.schedules.filter((s) => s.provider === provider) : [];
  return (
    <section className="admin-credit" aria-label={use.label}>
      {/* The limit stands beside the word that changes it; what is left, beside its meter. */}
      <div className="cluster--between">
        <span className="cluster">
          <span className="admin-credit-name">{use.label}</span>
          {!!use.limit && (
            <span className="faint tabular">
              {shown(use.limit)} {provider ? 'granted' : 'a day'}
            </span>
          )}
          {use.own && <Word tone="neutral" value="own" />}
        </span>
        <button
          type="button"
          className="btn-text"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Cancel' : provider ? 'Give credit' : 'Set limit'}
        </button>
      </div>
      <div className="cluster--between tabular">
        <span>
          {shown(use.used[props.span])} <span className="faint">used</span>
        </span>
        {!!use.limit && use.left !== null && (
          <span className="cluster">
            <span className="home-meter" aria-hidden="true">
              <span style={{ width: `${100 * share}%` }} />
            </span>
            <span className={cx(use.left <= 0 && 'status--bad')}>
              <span className="admin-left">{shown(use.left)}</span> left
            </span>
          </span>
        )}
      </div>
      {open &&
        (provider ? (
          <GiveForm provider={provider} of={of} close={() => setOpen(false)} done={done} />
        ) : (
          <LimitForm use={use} person={of.person.key} close={() => setOpen(false)} done={done} />
        ))}
      {grants.length + schedules.length > 0 && (
        <ul className="admin-ledger">
          {grants.map((g) => (
            <li
              key={g.id}
              title={`${usd(g.used)} used · ${usd(g.reserved)} reserved · from ${stamp(g.valid_from)}`}
            >
              <span>{usd(g.amount)}</span>
              {over(g) ? (
                <Word tone="dim" value={over(g)!} />
              ) : (
                <>
                  <span className="faint">{usd(g.available)} left</span>
                  {g.expires_at && <span className="faint">until {when(g.expires_at)}</span>}
                </>
              )}
              <span className="faint">{g.reason}</span>
              {more(
                !over(g) && {
                  id: g.id,
                  verb: 'Revoke grant',
                  says: `${usd(g.available)} left of ${usd(g.amount)} ${g.provider} · ${of.person.label}`,
                  path: `/admin/credits/grants/${encodeURIComponent(g.id)}/revoke`,
                },
              )}
              {guard(g.id)}
            </li>
          ))}
          {schedules.map((s) => (
            <li key={s.id}>
              <span>
                {usd(s.amount)} {s.cadence}
              </span>
              <Word tone={s.enabled ? 'ok' : 'dim'} value={s.enabled ? 'on' : 'paused'} />
              <span className="faint">from {when(s.starts_at)}</span>
              {s.ends_at && <span className="faint">until {when(s.ends_at)}</span>}
              {more({
                id: s.id,
                verb: s.enabled ? 'Pause schedule' : 'Resume schedule',
                says: `${usd(s.amount)} ${s.provider} ${s.cadence} · ${of.person.label}`,
                path: '/admin/credits/schedules',
                // The same id with the same terms only switches a schedule on or off.
                body: {
                  id: s.id,
                  person: of.person.key,
                  provider: s.provider,
                  amount: s.amount,
                  cadence: s.cadence,
                  startsAt: s.starts_at,
                  validityPeriods: s.validity_periods,
                  endsAt: s.ends_at,
                  enabled: !s.enabled,
                },
              })}
              {guard(s.id)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The person's drawer: one window for every credit type, then each type and its control. */
function Drawer(props: {
  person: Person;
  span: Span;
  onSpan(span: Span): void;
  onClose(): void;
  done(): void;
}) {
  const { person } = props;
  const read = useTool<PersonCredits>(
    `/admin/credits/people/${encodeURIComponent(person.id)}`,
    {},
    { every: 60_000 },
  );
  // The cursor goes to the name of who opened.
  const heading = useRef<HTMLHeadingElement>(null);
  useHeadFocus(true, heading);
  const done = () => {
    read.reload();
    props.done();
  };
  return (
    <div className="running-sidebar">
      <header className="running-panel-head">
        <div className="running-panel-top">
          <h2 id="admin-drawer-title" className="running-panel-title" tabIndex={-1} ref={heading}>
            {person.label}
          </h2>
          <button type="button" className="btn-text" onClick={props.onClose}>
            Close
          </button>
        </div>
        <div>
          <Segments label="Window" options={WINDOWS} value={props.span} onChange={props.onSpan} />
        </div>
      </header>
      <LoadState {...read} />
      {read.data?.kinds.map((use) => (
        <Use key={use.kind} use={use} span={props.span} of={read.data!} done={done} />
      ))}
    </div>
  );
}

export function CreditsView() {
  const credits = useTool<AdminCredits>('/admin/credits', {}, { every: 60_000 });
  const data = credits.data;
  const filter = useListFilter(
    data?.people.map((p): Person => ({ ...p, id: p.key })),
    { labels: (person) => [person.label] },
  );
  // A column per credit type, in the order the people carry them, named as their owner names it.
  const kinds = new Map(data?.people.flatMap((p) => p.kinds.map((k) => [k.kind, k.label])));
  const [openId, setOpen] = useState<string>();
  const [span, setSpan] = useState<Span>('day');
  const roomy = useRoomy();
  const person = filter.rows.find((p) => p.id === openId);
  const close = () => setOpen(undefined);
  useSidebarEscape(!!person, close);
  // Closing hands the cursor back to the name that opened the drawer.
  const last = useRef<string>();
  useEffect(() => {
    if (!openId && last.current)
      [...document.querySelectorAll<HTMLElement>('.admin-name')]
        .find((name) => name.dataset.person === last.current)
        ?.focus();
    last.current = openId;
  }, [openId]);
  // While it is open, ↑ and ↓ open the person above or below.
  const rows = useRef(filter.rows);
  rows.current = filter.rows;
  useEffect(() => {
    if (!openId) return;
    const onKey = (event: KeyboardEvent) => {
      const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (!step || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      const next = rows.current[rows.current.findIndex((p) => p.id === openId) + step];
      if (!next) return;
      event.preventDefault();
      setOpen(next.id);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openId]);
  const columns: Column<Person>[] = [
    col('person', 'Person', (p) => (
      <button
        type="button"
        className="admin-name"
        data-person={p.id}
        aria-expanded={openId === p.id}
        aria-controls="admin-drawer"
        onClick={() => setOpen(openId === p.id ? undefined : p.id)}
      >
        {p.label}
      </button>
    )),
    ...[...kinds].map(([kind, label]) =>
      fig<Person>(kind, label, (p) => today(p.kinds.find((k) => k.kind === kind))),
    ),
  ];
  const people = data?.people.length;
  return (
    <div className="running">
      <div className="running-plane" data-open={person ? '' : undefined}>
        <div className="work-main" hidden={!!person && !roomy}>
          <ListPage
            load={credits}
            noun="people"
            kind=""
            filter={filter}
            lede={(ends) => (
              <Head
                title="Credits"
                ends={ends}
                facts={data && [[people!, people === 1 ? 'person' : 'people']]}
              />
            )}
            listed={false}
            drawn={
              filter.rows.length > 0 && (
                <Ruled
                  label="Credits"
                  template={`minmax(0, 1.4fr) repeat(${kinds.size}, minmax(0, 1fr))`}
                  columns={columns}
                  rows={filter.rows}
                  keyOf={(p) => p.id}
                  row={(p) => ({
                    className: cx('admin-opens', openId === p.id && 'admin-unfolded'),
                    onClick: (event) => openRow(event, '.admin-name'),
                  })}
                />
              )
            }
            emptyTitle="No one holds credit"
            columns={5}
          />
        </div>
        <aside
          id="admin-drawer"
          className="running-panel"
          aria-labelledby="admin-drawer-title"
          hidden={!person}
        >
          {person && (
            <Drawer
              key={person.id}
              person={person}
              span={span}
              onSpan={setSpan}
              onClose={close}
              done={credits.reload}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
