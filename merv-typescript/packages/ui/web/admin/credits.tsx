import { useState, type FormEvent, type ReactNode } from 'react';
import type { AdminCredits, CreditAccount, CreditPerson } from '@merv/admin/models';
import { accountRequest, useTool } from '../api';
import {
  ConfirmAction,
  Failure,
  Field,
  OpenedForm,
  PageHeader,
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
import { Facts, None, Of, count, fig, usd } from './parts';

/** Whoever holds credit: a person and the accounts they belong to, or an account nobody does. */
interface Holder extends Pick<CreditPerson, 'label' | 'fleet' | 'pi'> {
  id: string;
  accounts: { account: CreditAccount; role?: string }[];
}
function holders(data: AdminCredits): Holder[] {
  const byId = new Map(data.accounts.map((account) => [account.accountId, account]));
  const held = new Set(data.people.flatMap((p) => p.accounts.map((a) => a.accountId)));
  return [
    ...data.people.map((p) => ({
      id: `${p.issuer}|${p.subject}`,
      label: p.label,
      accounts: p.accounts.flatMap(({ accountId, role }) =>
        byId.has(accountId) ? [{ account: byId.get(accountId)!, role }] : [],
      ),
      fleet: p.fleet,
      pi: p.pi,
    })),
    ...data.accounts
      .filter((account) => !held.has(account.accountId))
      .map((account) => ({
        id: account.accountId,
        label: account.name,
        accounts: [{ account }],
        fleet: null,
        pi: null,
      })),
  ];
}
/** What a holder's accounts hold of one provider, summed. */
const pooled = (holder: Holder, provider: string) => {
  const pools = holder.accounts.flatMap(({ account }) =>
    account.pools.filter((pool) => pool.provider === provider),
  );
  const sum = (key: 'granted' | 'available') => pools.reduce((n, pool) => n + Number(pool[key]), 0);
  return pools.length ? { left: sum('available'), granted: sum('granted') } : null;
};

/** A day, with its minute in the hover title. */
const Day = ({ at }: { at: string | null }) =>
  at ? (
    <time dateTime={at} title={stamp(at)}>
      {day(at)}
    </time>
  ) : (
    <None />
  );

/** One POST to an /admin route, behind the guard that names it; done, the page is read again. */
function Guarded({
  title,
  confirm,
  path,
  body,
  danger,
  children,
  close,
  done,
}: {
  title: string;
  confirm: string;
  path: string;
  body: Record<string, unknown>;
  danger?: boolean;
  children: ReactNode;
  close(): void;
  done(): void;
}) {
  const command = useCommand<unknown>({
    tool: path,
    idempotent: true,
    send: (input) => accountRequest(path, { method: 'POST', body: input }),
    validate: (result) => !!result,
    onSuccess: () => {
      close();
      done();
    },
  });
  return (
    <ConfirmAction
      opened
      label={confirm}
      title={title}
      confirm={confirm}
      danger={danger}
      busy={command.busy ? 'Working…' : undefined}
      note={<Failure message={command.error} />}
      onToggle={(open) => !open && close()}
      onConfirm={() => command.submit(body)}
    >
      {children}
    </ConfirmAction>
  );
}

const More = ({ open, label, onClick }: { open: boolean; label: string; onClick(): void }) => (
  <button
    type="button"
    className="btn-icon btn-icon--inline file-menu-open admin-more"
    aria-label={label}
    title={label}
    aria-expanded={open}
    onClick={onClick}
  >
    ⋯
  </button>
);

type Grant = CreditAccount['grants'][number];
type Schedule = CreditAccount['schedules'][number];

function Account({
  account,
  role,
  reload,
}: {
  account: CreditAccount;
  role?: string;
  reload(): void;
}) {
  const [acting, setActing] = useState<string>();
  const close = () => setActing(undefined);
  const now = new Date().toISOString();
  const over = (grant: Grant) =>
    grant.revoked_at
      ? 'revoked'
      : grant.expires_at && grant.expires_at < now
        ? 'expired'
        : undefined;
  const more = (id: string, label: string) => (
    <More
      open={acting === id}
      label={label}
      onClick={() => setActing(acting === id ? undefined : id)}
    />
  );
  // What the account holds of each provider, and every cap beside it, said on its head.
  const clauses = [
    role,
    ...account.projects.map((p) => p.name),
    ...account.pools.map(
      (pool) => `${pool.provider} ${usd(pool.available)} of ${usd(pool.granted)}`,
    ),
    ...account.budgets.map(
      (b) =>
        b.cap !== null &&
        `cap ${b.metric === 'money' ? usd(b.cap) : `${b.cap} h`} ${b.window === 'all_time' ? 'in all' : `a ${b.window}`}${b.provider ? ` ${b.provider}` : ''}`,
    ),
  ].filter(Boolean);
  const grant = account.grants.find((g) => g.id === acting);
  const schedule = account.schedules.find((s) => s.id === acting);
  const grants: Column<Grant>[] = [
    col('grant', 'Grant', (g) => (
      <>
        <span className="tabular">{usd(g.amount)}</span> {g.provider}
        {g.schedule_id && <span className="faint"> · scheduled</span>}
      </>
    )),
    fig('used', 'Used', (g) => usd(g.used)),
    fig('left', 'Left', (g) => <span className="admin-left">{usd(g.available)}</span>),
    fig('reserved', 'Reserved', (g) => usd(g.reserved)),
    fig('from', 'From', (g) => <Day at={g.valid_from} />),
    fig('expires', 'Expires', (g) =>
      over(g) ? <Word tone="dim" value={over(g)!} /> : <Day at={g.expires_at} />,
    ),
    col('reason', 'Reason', (g) => g.reason),
    fig('more', '', (g) => !over(g) && more(g.id, 'Revoke grant')),
  ];
  const schedules: Column<Schedule>[] = [
    col('schedule', 'Schedule', (s) => (
      <>
        <span className="tabular">{usd(s.amount)}</span> {s.provider}
      </>
    )),
    fig('every', 'Every', (s) => s.cadence),
    fig('starts', 'Starts', (s) => <Day at={s.starts_at} />),
    fig('ends', 'Ends', (s) => <Day at={s.ends_at} />),
    fig('lasts', 'Lasts', ({ validity_periods: n }) =>
      n === null ? 'rolls over' : `${n} ${n === 1 ? 'period' : 'periods'}`,
    ),
    col('state', 'State', (s) => (
      <Word tone={s.enabled ? 'ok' : 'dim'} value={s.enabled ? 'on' : 'paused'} />
    )),
    fig('more', '', (s) => more(s.id, s.enabled ? 'Pause schedule' : 'Resume schedule')),
  ];
  return (
    <section className="admin-account stack" aria-label={account.name}>
      <h3 className="admin-account-head">
        {account.name}
        <span className="faint">{clauses.map((clause) => ` · ${clause}`)}</span>
      </h3>
      {account.grants.length > 0 && (
        <Ruled
          label="Grants"
          template="minmax(0, 1.4fr) repeat(3, 80px) 72px 80px minmax(0, 2fr) 32px"
          columns={grants}
          rows={account.grants}
          keyOf={(g) => g.id}
        />
      )}
      {account.schedules.length > 0 && (
        <Ruled
          label="Schedules"
          template="minmax(0, 1.4fr) repeat(4, 96px) minmax(0, 2fr) 32px"
          columns={schedules}
          rows={account.schedules}
          keyOf={(s) => s.id}
        />
      )}
      {grant && (
        <Guarded
          title="Revoke grant?"
          confirm="Revoke grant"
          danger
          path={`/admin/credits/grants/${encodeURIComponent(grant.id)}/revoke`}
          body={{}}
          close={close}
          done={reload}
        >
          <p>
            {usd(grant.available)} left of {usd(grant.amount)} {grant.provider} · {account.name}
          </p>
        </Guarded>
      )}
      {schedule && (
        <Guarded
          title={schedule.enabled ? 'Pause schedule?' : 'Resume schedule?'}
          confirm={schedule.enabled ? 'Pause schedule' : 'Resume schedule'}
          path="/admin/credits/schedules"
          // The same id with the same terms only switches a schedule on or off.
          body={{
            id: schedule.id,
            accountId: account.accountId,
            provider: schedule.provider,
            amount: schedule.amount,
            cadence: schedule.cadence,
            startsAt: schedule.starts_at,
            validityPeriods: schedule.validity_periods,
            endsAt: schedule.ends_at,
            enabled: !schedule.enabled,
          }}
          close={close}
          done={reload}
        >
          <p>
            {usd(schedule.amount)} {schedule.provider} {schedule.cadence} · {account.name}
          </p>
        </Guarded>
      )}
    </section>
  );
}

const CADENCES = ['once', 'daily', 'weekly', 'monthly'] as const;

/** One form assigns credit: a grant now, or a schedule that grants on every period. */
function GrantForm({
  holder,
  providers,
  reload,
  close,
}: {
  holder: Holder;
  providers: string[];
  reload(): void;
  close(): void;
}) {
  const [accountId, setAccount] = useState(holder.accounts[0]!.account.accountId);
  const [provider, setProvider] = useState(providers[0]!);
  const [amount, setAmount] = useState('');
  const [cadence, setCadence] = useState<(typeof CADENCES)[number]>('once');
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const once = cadence === 'once';
  const command = useCommand<{ id: string }>({
    tool: 'credits.grant',
    // The grant's own id is its idempotency key, made once per submission and kept for a retry.
    idempotent: true,
    send: (body) =>
      accountRequest(body.cadence ? '/admin/credits/schedules' : '/admin/credits/grants', {
        method: 'POST',
        body,
      }),
    validate: (result) => typeof result?.id === 'string',
    onSuccess: () => {
      close();
      reload();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const terms = { id: crypto.randomUUID(), accountId, provider, amount: amount.trim() };
    const at = new Date().toISOString();
    const end = until ? new Date(until).toISOString() : null;
    void command.submit(
      once
        ? { ...terms, validFrom: at, ...(end && { expiresAt: end }), reason }
        : { ...terms, cadence, startsAt: at, validityPeriods: 1, endsAt: end, enabled: true },
    );
  };
  const choose = (label: string, value: string, set: (v: string) => void, options: string[][]) => (
    <label>
      {label}
      <select value={value} onChange={(event) => set(event.target.value)}>
        {options.map(([v, l = v]) => (
          <option key={v} value={v}>
            {l}
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
        {holder.accounts.length > 1 &&
          choose(
            'Account',
            accountId,
            setAccount,
            holder.accounts.map(({ account }) => [account.accountId, account.name]),
          )}
        {choose(
          'Provider',
          provider,
          setProvider,
          providers.map((p) => [p]),
        )}
        <Field
          label="Amount"
          className="tabular"
          inputMode="decimal"
          required
          pattern="\s*\d+(\.\d{1,6})?\s*"
          placeholder="0.00"
          value={amount}
          onChange={setAmount}
        />
        {choose(
          'Repeats',
          cadence,
          (v) => setCadence(v as typeof cadence),
          CADENCES.map((c) => [c]),
        )}
        <Field
          label={once ? 'Expires' : 'Ends'}
          type="datetime-local"
          value={until}
          onChange={setUntil}
        />
        {once && (
          <Field label="Reason" required maxLength={2000} value={reason} onChange={setReason} />
        )}
      </fieldset>
      {/* Outside the fields it locks, so a request kept for a retry can be sent again. */}
      <div>
        <Submit label="Grant" busy={command.busy} retry={command.retry} saving="Granting…" />
      </div>
      <Failure message={command.error} />
    </OpenedForm>
  );
}

/** A person unfolded: their accounts, and the quiet word that opens the grant form. */
function Holding({
  holder,
  providers,
  reload,
}: {
  holder: Holder;
  providers: string[];
  reload(): void;
}) {
  const [granting, setGranting] = useState(false);
  return (
    <div className="admin-holding stack stack--lg">
      {holder.accounts.map(({ account, role }) => (
        <Account key={account.accountId} account={account} role={role} reload={reload} />
      ))}
      {granting ? (
        <GrantForm
          holder={holder}
          providers={providers}
          reload={reload}
          close={() => setGranting(false)}
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
}

export function CreditsView() {
  const credits = useTool<AdminCredits>('/admin/credits', {}, { every: 60_000 });
  const [open, setOpen] = useState<string>();
  const data = credits.data;
  const providers = data?.providers ?? [];
  const filter = useListFilter(data && holders(data), {
    labels: (holder) => [holder.label, ...holder.accounts.map(({ account }) => account.name)],
  });
  const columns: Column<Holder>[] = [
    col('person', 'Person', (holder) => (
      <button
        type="button"
        className="admin-name"
        aria-expanded={open === holder.id}
        onClick={() => setOpen(open === holder.id ? undefined : holder.id)}
      >
        {holder.label}
      </button>
    )),
    ...providers.map((provider) =>
      fig<Holder>(provider, provider, (holder) => {
        const pool = pooled(holder, provider);
        return pool ? (
          <Of used={<span className="admin-left">{usd(pool.left)}</span>} of={usd(pool.granted)} />
        ) : (
          <None />
        );
      }),
    ),
    fig('fleet', 'Fleet today', ({ fleet }) =>
      fleet ? (
        <span className={cx(!!fleet.usdCap && fleet.usd >= fleet.usdCap && 'status--bad')}>
          <Of used={usd(fleet.usd)} of={fleet.usdCap === null ? undefined : usd(fleet.usdCap)} />
        </span>
      ) : (
        <None />
      ),
    ),
    fig('tokens', 'Fleet tokens', ({ fleet }) =>
      fleet?.tokens ? (
        <Of used={count(fleet.tokens.used)} of={count(fleet.tokens.limit)} />
      ) : (
        <None />
      ),
    ),
    fig('agent', 'Agent tokens', ({ pi }) =>
      pi ? <Of used={count(pi.used)} of={count(pi.limit)} /> : <None />,
    ),
  ];
  return (
    <ListPage
      load={credits}
      noun="people"
      kind=""
      filter={filter}
      lede={(ends) => (
        <PageHeader
          title="Credits"
          summary={
            data && (
              <Facts
                facts={[
                  [data.people.length, data.people.length === 1 ? 'person' : 'people'],
                  [data.accounts.length, data.accounts.length === 1 ? 'account' : 'accounts'],
                ]}
              />
            )
          }
          actions={ends}
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
            under={(holder) =>
              open === holder.id && (
                <Holding holder={holder} providers={providers} reload={credits.reload} />
              )
            }
          />
        )
      }
      emptyTitle="No one holds credit"
      columns={5}
    />
  );
}
