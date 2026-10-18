import { useState, type FormEvent, type ReactNode } from 'react';
import type { AdminCredits, CreditAccount, CreditPerson } from '@merv/admin/models';
import { accountRequest, useTool } from '../api';
import {
  ConfirmAction,
  Failure,
  Field,
  OpenedForm,
  Ruled,
  Submit,
  Word,
  col,
  cx,
  stamp,
  type Column,
} from '../components';
import { ListPage, useListFilter } from '../list-filters';
import { useCommand } from '../mutations';
import { day } from '../session';
import { Head, Of, count, fig, usd } from './parts';

/** Whoever holds credit: a person and the accounts they belong to, or an account nobody does. */
interface Holder extends Pick<CreditPerson, 'label' | 'fleet' | 'pi'> {
  id: string;
  accounts: (CreditAccount & { role?: string })[];
}
function holders({ people, accounts }: AdminCredits): Holder[] {
  const byId = new Map(accounts.map((account) => [account.accountId, account]));
  const held = new Set(people.flatMap((p) => p.accounts.map((a) => a.accountId)));
  return [
    ...people.map((p) => ({
      ...p,
      id: `${p.issuer}|${p.subject}`,
      accounts: p.accounts.map(({ accountId, role }) => ({ ...byId.get(accountId)!, role })),
    })),
    ...accounts
      .filter((account) => !held.has(account.accountId))
      .map((account) => ({ id: account.accountId, label: account.name, accounts: [account] })),
  ].map((holder) => ({ fleet: null, pi: null, ...holder }));
}
/** What a holder's accounts hold of one provider, summed: what is left of what was granted. */
function pooled(holder: Holder, provider: string) {
  const pools = holder.accounts.flatMap((a) => a.pools).filter((p) => p.provider === provider);
  const sum = (key: 'granted' | 'available') =>
    usd(pools.reduce((n, pool) => n + Number(pool[key]), 0));
  return pools.length ? (
    <Of used={<span className="admin-left">{sum('available')}</span>} of={sum('granted')} />
  ) : null;
}
const tokens = (today?: { used: number; limit: number } | null) =>
  today && <Of used={count(today.used)} of={count(today.limit)} />;
/** A day, with its minute in the hover title. */
const when = (at: string | null) =>
  at && (
    <time dateTime={at} title={stamp(at)}>
      {day(at)}
    </time>
  );

/** A POST to an /admin route, sent whole again on a retry; done, it closes and the page reloads. */
const usePost = (close: () => void, done: () => void) =>
  useCommand<{ id: string }>({
    tool: 'admin.credits',
    // Each body names its own id, so a retry is the same write.
    idempotent: true,
    send: ({ path, ...body }) => accountRequest(String(path), { method: 'POST', body }),
    validate: (result) => typeof result?.id === 'string',
    onSuccess: () => {
      close();
      done();
    },
  });

/** What ⋯ on a grant or a schedule asks for: its verb, what it names, and the POST that does it. */
type Act = { id: string; verb: string; says: string; path: string; body?: Record<string, unknown> };
function Guard({ act, close, done }: { act: Act; close(): void; done(): void }) {
  const command = usePost(close, done);
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

const CADENCES = ['once', 'daily', 'weekly', 'monthly'];

/** One form assigns credit: a grant now, or a schedule that grants on every period. */
function GrantForm(props: { holder: Holder; providers: string[]; close(): void; done(): void }) {
  const { holder, providers, close, done } = props;
  const [form, setForm] = useState({
    accountId: holder.accounts[0]!.accountId,
    provider: providers[0]!,
    amount: '',
    cadence: 'once',
    until: '',
    reason: '',
  });
  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (value: string) => setForm({ ...form, [key]: value }),
  });
  const once = form.cadence === 'once';
  const command = usePost(close, done);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const { accountId, provider, amount, cadence, until, reason } = form;
    const path = `/admin/credits/${once ? 'grants' : 'schedules'}`;
    // The grant's own id is its idempotency key, made once per submission and kept for a retry.
    const terms = { path, id: crypto.randomUUID(), accountId, provider, amount: amount.trim() };
    const at = new Date().toISOString();
    const end = until ? new Date(until).toISOString() : null;
    void command.submit(
      once
        ? { ...terms, validFrom: at, expiresAt: end, reason }
        : { ...terms, cadence, startsAt: at, validityPeriods: 1, endsAt: end, enabled: true },
    );
  };
  const accounts = new Map(holder.accounts.map((a) => [a.accountId, a.name]));
  const choose = (label: string, key: keyof typeof form, values: string[], names = new Map()) => (
    <label>
      {label}
      <select {...field(key)} onChange={(event) => field(key).onChange(event.target.value)}>
        {values.map((value) => (
          <option key={value} value={value}>
            {names.get(value) ?? value}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <OpenedForm
      className="stack entry-form"
      onClose={close}
      locked={command.locked}
      onSubmit={submit}
      aria-label={`Grant credits to ${holder.label}`}
    >
      <fieldset disabled={command.locked}>
        {accounts.size > 1 && choose('Account', 'accountId', [...accounts.keys()], accounts)}
        {choose('Provider', 'provider', providers)}
        <Field
          label="Amount"
          className="tabular"
          inputMode="decimal"
          required
          pattern="\s*\d+(\.\d{1,6})?\s*"
          placeholder="0.00"
          {...field('amount')}
        />
        {choose('Repeats', 'cadence', CADENCES)}
        <Field label={once ? 'Expires' : 'Ends'} type="datetime-local" {...field('until')} />
        {once && <Field label="Reason" required maxLength={2000} {...field('reason')} />}
      </fieldset>
      {/* Outside the fields it locks, so a request kept for a retry can be sent again. */}
      <div>
        <Submit label="Grant" busy={command.busy} retry={command.retry} saving="Granting…" />
      </div>
      <Failure message={command.error} />
    </OpenedForm>
  );
}

type Grant = CreditAccount['grants'][number];
type Schedule = CreditAccount['schedules'][number];

export function CreditsView() {
  const credits = useTool<AdminCredits>('/admin/credits', {}, { every: 60_000 });
  const [open, setOpen] = useState<string>();
  const [granting, setGranting] = useState(false);
  const [acting, setActing] = useState<Act>();
  const data = credits.data;
  const providers = data?.providers ?? [];
  const filter = useListFilter(data && holders(data), {
    labels: (holder) => [holder.label, ...holder.accounts.map((a) => a.name)],
  });
  /** Grants or schedules: what each is, its figures, a word that runs wide, and its act behind ⋯,
   *  whose guard opens under its row. */
  const ledger = <T extends Grant | Schedule>(
    label: string,
    rows: T[],
    columns: Column<T>[],
    act: (row: T) => Act | false,
  ) =>
    rows.length > 0 && (
      <Ruled
        label={label}
        template={`minmax(0, 1.4fr) repeat(${columns.length - 2}, 88px) minmax(0, 2fr) 32px`}
        columns={[
          ...columns,
          col<T>('more', '', (row) => {
            const asked = act(row);
            return asked ? (
              <button
                type="button"
                className="btn-icon btn-icon--inline file-menu-open admin-more"
                aria-label={asked.verb}
                title={asked.verb}
                aria-expanded={acting?.id === row.id}
                onClick={() => setActing(acting?.id === row.id ? undefined : asked)}
              >
                ⋯
              </button>
            ) : null;
          }),
        ]}
        rows={rows}
        keyOf={(row) => row.id}
        under={(row) =>
          acting?.id === row.id && (
            <Guard act={acting} close={() => setActing(undefined)} done={credits.reload} />
          )
        }
      />
    );
  const amount = (of: Grant | Schedule, more?: ReactNode) => (
    <>
      <span className="tabular">{usd(of.amount)}</span> {of.provider}
      {more}
    </>
  );
  const now = new Date().toISOString();
  const over = (g: Grant) =>
    g.revoked_at ? 'revoked' : g.expires_at && g.expires_at < now ? 'expired' : undefined;
  const account = (a: Holder['accounts'][number]) => (
    <section className="stack" aria-label={a.name} key={a.accountId}>
      <h3 className="admin-account-head">
        {a.name}
        {/* What the account holds of each provider, and every cap beside it. */}
        <span className="faint">
          {[
            a.role,
            ...a.projects.map((p) => p.name),
            ...a.pools.map((p) => `${p.provider} ${usd(p.available)} of ${usd(p.granted)}`),
            ...a.budgets.map(
              (b) =>
                b.cap !== null &&
                `${b.provider ? `${b.provider} ` : ''}cap ${b.metric === 'money' ? usd(b.cap) : `${b.cap} h`} ${b.window === 'all_time' ? 'in all' : `a ${b.window}`}`,
            ),
          ].map((clause) => clause && ` · ${clause}`)}
        </span>
      </h3>
      {ledger<Grant>(
        'Grants',
        a.grants,
        [
          col('grant', 'Grant', (g) =>
            amount(g, g.schedule_id && <span className="faint"> · scheduled</span>),
          ),
          fig('used', 'Used', (g) => usd(g.used)),
          fig('left', 'Left', (g) => <span className="admin-left">{usd(g.available)}</span>),
          fig('reserved', 'Reserved', (g) => usd(g.reserved)),
          fig('from', 'From', (g) => when(g.valid_from)),
          fig('expires', 'Expires', (g) =>
            over(g) ? <Word tone="dim" value={over(g)!} /> : when(g.expires_at),
          ),
          col('reason', 'Reason', (g) => g.reason),
        ],
        (g) =>
          !over(g) && {
            id: g.id,
            verb: 'Revoke grant',
            says: `${usd(g.available)} left of ${usd(g.amount)} ${g.provider} · ${a.name}`,
            path: `/admin/credits/grants/${encodeURIComponent(g.id)}/revoke`,
          },
      )}
      {ledger<Schedule>(
        'Schedules',
        a.schedules,
        [
          col('schedule', 'Schedule', (s) => amount(s)),
          fig('every', 'Every', (s) => s.cadence),
          fig('starts', 'Starts', (s) => when(s.starts_at)),
          fig('ends', 'Ends', (s) => when(s.ends_at)),
          fig('lasts', 'Lasts', ({ validity_periods: n }) =>
            n === null ? 'rolls over' : `${n} ${n === 1 ? 'period' : 'periods'}`,
          ),
          col('state', 'State', (s) => (
            <Word tone={s.enabled ? 'ok' : 'dim'} value={s.enabled ? 'on' : 'paused'} />
          )),
        ],
        (s) => ({
          id: s.id,
          verb: s.enabled ? 'Pause schedule' : 'Resume schedule',
          says: `${usd(s.amount)} ${s.provider} ${s.cadence} · ${a.name}`,
          path: '/admin/credits/schedules',
          // The same id with the same terms only switches a schedule on or off.
          body: {
            id: s.id,
            accountId: a.accountId,
            provider: s.provider,
            amount: s.amount,
            cadence: s.cadence,
            startsAt: s.starts_at,
            validityPeriods: s.validity_periods,
            endsAt: s.ends_at,
            enabled: !s.enabled,
          },
        }),
      )}
    </section>
  );
  const columns: Column<Holder>[] = [
    col('person', 'Person', (holder) => (
      <button
        type="button"
        className="admin-name"
        aria-expanded={open === holder.id}
        onClick={() => {
          setOpen(open === holder.id ? undefined : holder.id);
          setGranting(false);
        }}
      >
        {holder.label}
      </button>
    )),
    ...providers.map((provider) => fig<Holder>(provider, provider, (h) => pooled(h, provider))),
    fig('fleet', 'Fleet today', ({ fleet: f }) =>
      f ? (
        <Of
          className={cx(!!f.usdCap && f.usd >= f.usdCap && 'status--bad')}
          used={usd(f.usd)}
          of={f.usdCap === null ? null : usd(f.usdCap)}
        />
      ) : null,
    ),
    fig('tokens', 'Fleet tokens', ({ fleet }) => tokens(fleet?.tokens)),
    fig('agent', 'Agent tokens', ({ pi }) => tokens(pi)),
  ];
  // A person unfolded: their accounts, then the quiet word that opens the grant form.
  const holding = (holder: Holder) => (
    <div className="admin-holding stack stack--lg">
      {holder.accounts.map(account)}
      {granting ? (
        <GrantForm
          holder={holder}
          providers={providers}
          close={() => setGranting(false)}
          done={credits.reload}
        />
      ) : (
        holder.accounts.length > 0 &&
        providers.length > 0 && (
          <div>
            <button type="button" className="btn-text" onClick={() => setGranting(true)}>
              Grant
            </button>
          </div>
        )
      )}
    </div>
  );
  const [people, accounts] = [data?.people.length, data?.accounts.length];
  return (
    <ListPage
      load={credits}
      noun="people"
      kind=""
      filter={filter}
      lede={(ends) => (
        <Head
          title="Credits"
          ends={ends}
          facts={
            data && [
              [people!, people === 1 ? 'person' : 'people'],
              [accounts!, accounts === 1 ? 'account' : 'accounts'],
            ]
          }
        />
      )}
      listed={false}
      drawn={
        filter.rows.length > 0 && (
          <Ruled
            label="Credits"
            template={`minmax(0, 1.4fr) repeat(${providers.length + 3}, minmax(0, 1fr))`}
            columns={columns}
            rows={filter.rows}
            keyOf={(holder) => holder.id}
            row={(holder) => ({ className: cx(open === holder.id && 'admin-unfolded') })}
            under={(holder) => open === holder.id && holding(holder)}
          />
        )
      }
      emptyTitle="No one holds credit"
      columns={5}
    />
  );
}
