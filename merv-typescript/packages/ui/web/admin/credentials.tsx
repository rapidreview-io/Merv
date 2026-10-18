import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type {
  AdminCredentials,
  CredentialTarget,
  PlatformSecret,
  ProviderKey,
} from '@merv/admin/models';
import { accountRequest, useTool } from '../api';
import {
  Ago,
  CopyButton,
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
  toneOf,
  useNow,
  words,
} from '../components';
import { elapsed } from '../liveness';
import { Head, fig, usePost } from './parts';

/** A revealed value stands this long, then leaves the page. */
const SHOWN_MS = 30_000;

/** Set, unset, dead, or failing since its last success: red is a key that does not work. */
const stateOf = (s: PlatformSecret) =>
  !s.set
    ? 'unset'
    : s.dead
      ? 'dead'
      : s.lastFailure && (!s.lastOk || s.lastFailure.at > s.lastOk.at)
        ? 'failing'
        : 'set';
const TONE: Record<string, string> = { set: 'ok', unset: 'dim', dead: 'bad', failing: 'bad' };
/** What it is for, in the text colour, and the name it is kept under beneath it. */
const Named = (props: { what: string; name: string; title?: string }) => (
  <span>
    {props.what}
    <span className="mono admin-env" title={props.title}>
      {props.name}
    </span>
  </span>
);

const keyOf = (target: CredentialTarget) =>
  'env' in target ? target.env : `${target.provider}:${target.field}`;
const targetOf = (row: PlatformSecret | ProviderKey): CredentialTarget =>
  'env' in row ? { env: row.env } : { provider: row.provider, field: row.field };

/** What a row's words opened: its value (asked, shown or refused), or the form that changes it. */
type Open = {
  key: string;
  act: 'reveal' | 'change';
  value?: string;
  error?: string;
  until?: number;
};
/** What the row is for, and the name it is kept under: what a form that changes it names. */
const namesOf = (row: PlatformSecret | ProviderKey) =>
  'env' in row ? [row.purpose, row.env] : [`${row.provider} · ${row.description}`, row.field];

/** A revealed value: the mono to read or copy, and the seconds it has left on the page. */
function Shown({ value, until, hide }: { value: string; until: number; hide(): void }) {
  const left = Math.min(SHOWN_MS / 1000, Math.ceil((until - useNow(1000)) / 1000));
  const over = left <= 0;
  useEffect(() => {
    if (over) hide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [over]);
  return (
    <div className="admin-said">
      <code className="mono admin-secret">{value}</code>
      <CopyButton text={value} />
      <span className="faint tabular">{Math.max(0, left)}s</span>
    </div>
  );
}

/** One input for the new value; the server checks it, reloads what reads it, and says which. */
function Change(props: {
  target: CredentialTarget;
  what: string;
  name: string;
  close(): void;
  done(reloaded: string[]): void;
}) {
  const { target, close } = props;
  const [value, setValue] = useState('');
  const command = usePost<{ ok: boolean; reloaded: string[] }>(
    (result) => props.done(result.reloaded),
    (result) => result?.ok === true && Array.isArray(result.reloaded),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const path = '/admin/credentials/change';
    void command.submit(
      'env' in target
        ? { path, env: target.env, value }
        : { path, provider: target.provider, fields: { [target.field]: value } },
    );
  };
  return (
    <OpenedForm
      className="guard entry-form"
      onClose={close}
      locked={command.locked}
      onSubmit={submit}
      aria-label={`Change ${props.what}`}
    >
      <strong>{props.what}</strong>
      <fieldset disabled={command.locked}>
        <Field
          label={<span className="mono">{props.name}</span>}
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          value={value}
          onChange={setValue}
        />
      </fieldset>
      <div className="cluster">
        <Submit label="Save" busy={command.busy} retry={command.retry} />
        <button type="button" className="btn" disabled={command.busy} onClick={close}>
          Cancel
        </button>
      </div>
      <Failure message={command.error} />
    </OpenedForm>
  );
}

/**
 * What a row's quiet words open, one at a time: its value for 30 s, or the form that changes
 * it. Each reveal is one POST, asked from the click and never kept past its time.
 */
function useActs(reload: () => void) {
  const [open, setOpen] = useState<Open>();
  const [saved, setSaved] = useState<{ key: string; reloaded: string[] }>();
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(undefined), 8000);
    return () => clearTimeout(timer);
  }, [saved]);
  const reveal = async (key: string, target: CredentialTarget) => {
    if (open?.key === key && open.act === 'reveal') return setOpen(undefined);
    setOpen({ key, act: 'reveal' });
    const answer = (next: Open) =>
      setOpen((now) => (now?.key === key && now.act === 'reveal' ? next : now));
    try {
      const { value } = await accountRequest<{ value: string }>('/admin/credentials/reveal', {
        method: 'POST',
        body: target,
      });
      answer({ key, act: 'reveal', value, until: Date.now() + SHOWN_MS });
    } catch (failure) {
      answer({ key, act: 'reveal', error: (failure as Error).message });
    }
  };
  /** The row's words, drawn as the pointer reaches it. */
  const controls = (row: PlatformSecret | ProviderKey, revealable: boolean) => {
    if (!row.editable) return null;
    const target = targetOf(row);
    const key = keyOf(target);
    const on = (act: string) => open?.key === key && open.act === act;
    return (
      <span className="admin-acts">
        {revealable && (
          <button
            type="button"
            className="btn-text"
            aria-expanded={on('reveal')}
            onClick={() => void reveal(key, target)}
          >
            {on('reveal') ? 'Hide' : 'Reveal'}
          </button>
        )}
        <button
          type="button"
          className="btn-text"
          aria-expanded={on('change')}
          onClick={() => setOpen(on('change') ? undefined : { key, act: 'change' })}
        >
          Change
        </button>
      </span>
    );
  };
  /** What stands under the row: the value, the form, or what the change reloaded. */
  const under = <T extends PlatformSecret | ProviderKey>(row: T): ReactNode => {
    const target = targetOf(row);
    const key = keyOf(target);
    const [what, name] = namesOf(row);
    if (open?.key === key && open.act === 'change')
      return (
        <Change
          target={target}
          what={what!}
          name={name!}
          close={() => setOpen(undefined)}
          done={(reloaded) => {
            setOpen(undefined);
            setSaved({ key, reloaded });
            reload();
          }}
        />
      );
    if (open?.key === key && open.act === 'reveal') {
      if (open.error) return <Failure message={open.error} />;
      return open.value !== undefined && open.until ? (
        <Shown value={open.value} until={open.until} hide={() => setOpen(undefined)} />
      ) : null;
    }
    if (saved?.key === key)
      return (
        <p className="admin-said faint" role="status">
          {saved.reloaded.length ? `Reloaded ${saved.reloaded.join(' · ')}` : 'Saved'}
        </p>
      );
    return null;
  };
  const unfolded = <T extends PlatformSecret | ProviderKey>(row: T) => ({
    className: cx(open?.key === keyOf(targetOf(row)) && 'admin-unfolded'),
  });
  return { controls, under, unfolded };
}

type Minted = AdminCredentials['minted'][number];
const MINTED = [
  col<Minted>('owner', 'Minted by', (m) => m.owner),
  col<Minted>('kind', 'Kind', (m) => words(m.kind)),
  fig<Minted>('live', 'Live', (m) => m.live),
  fig<Minted>('expiry', 'Next expiry', ({ soonestExpiry: at }) =>
    at ? (
      <time dateTime={at} title={stamp(at)}>
        in {elapsed(Date.parse(at) - Date.now())}
      </time>
    ) : null,
  ),
  fig<Minted>('revoked', 'Revoked 24h', (m) => Number(m.revokedLastDay) || null),
  fig<Minted>('issued', 'Last issued', (m) => <Ago at={m.newestIssued} />),
];

export function CredentialsView() {
  const read = useTool<AdminCredentials>('/admin/credentials', {}, { every: 60_000 });
  const acts = useActs(read.reload);
  const groups = read.data?.groups ?? [];
  const providers = read.data?.providers ?? [];
  const states = [
    ...groups.flatMap((g) => g.secrets.map(stateOf)),
    ...providers.map((p) => (p.present === null ? '' : p.present ? 'set' : 'unset')),
  ];
  const counted = (state: string) => states.filter((s) => s === state).length;
  const secrets = [
    col<PlatformSecret>('purpose', 'Purpose', (s) => (
      <Named
        what={s.purpose}
        name={s.env}
        title={[`${s.plugin} · ${s.field}`, ...s.sharedWith.map((o) => `= ${o.env}`)].join('\n')}
      />
    )),
    col<PlatformSecret>('state', 'State', (s) => (
      <Word tone={TONE[stateOf(s)]!} value={stateOf(s)} />
    )),
    fig<PlatformSecret>('changed', 'Changed', (s) => s.lastChanged && <Ago at={s.lastChanged} />),
    fig<PlatformSecret>('ok', 'Last ok', ({ lastOk: ok }) =>
      ok ? (
        <span title={`${ok.relay} · ${ok.model}`}>
          <Ago at={ok.at} />
        </span>
      ) : null,
    ),
    fig<PlatformSecret>('failure', 'Last failure', ({ lastFailure: failed, lastOk: ok }) =>
      failed ? (
        <span
          className={cx(ok && ok.at > failed.at && 'faint')}
          title={[failed.status, failed.code, failed.relay, failed.model]
            .filter(Boolean)
            .join(' · ')}
        >
          <Ago at={failed.at} />
        </span>
      ) : null,
    ),
    col<PlatformSecret>('acts', '', (s) => acts.controls(s, s.set)),
  ];
  const keys = [
    col<ProviderKey>('provider', 'Provider', (p) => (
      <>
        {p.provider}{' '}
        {p.health && (
          <Word
            tone={p.health === 'ok' ? 'ok' : toneOf(p.health)}
            value={p.health}
            title={p.healthReason ?? undefined}
          />
        )}
      </>
    )),
    col<ProviderKey>('key', 'Key', (p) => <Named what={p.description} name={p.field} />),
    col<ProviderKey>('present', 'Present', ({ present: on }) =>
      on === null ? null : <Word tone={on ? 'ok' : 'dim'} value={on ? 'set' : 'unset'} />,
    ),
    col<ProviderKey>('acts', '', (p) => acts.controls(p, !!p.present)),
  ];
  return (
    <div className="page-stage stack stack--lg">
      <Head
        title="Credentials"
        facts={
          read.data && [
            [counted('set'), 'set'],
            counted('unset') > 0 && [counted('unset'), 'unset'],
            counted('dead') > 0 && [counted('dead'), 'dead', true],
            counted('failing') > 0 && [counted('failing'), 'failing', true],
          ]
        }
      />
      <LoadState {...read} columns={6} />
      {groups.map(({ purpose, secrets: rows }) => (
        <section className="stack admin-purpose" key={purpose}>
          <h2 className="section-title admin-group">{purpose}</h2>
          <Ruled
            label={purpose}
            template="minmax(0, 2.4fr) 84px repeat(3, 100px) minmax(116px, 0.8fr)"
            columns={secrets}
            rows={rows}
            keyOf={(s) => `${s.env}:${s.field}`}
            row={acts.unfolded}
            under={acts.under}
          />
        </section>
      ))}
      {providers.length > 0 && (
        <section className="stack">
          <h2 className="section-title admin-group">Sandbox providers</h2>
          <Ruled
            label="Sandbox providers"
            template="minmax(0, 1fr) minmax(0, 2fr) 84px minmax(116px, 0.8fr)"
            columns={keys}
            rows={providers}
            keyOf={(p) => keyOf(targetOf(p))}
            row={acts.unfolded}
            under={acts.under}
          />
        </section>
      )}
      {!!read.data?.minted.length && (
        <section className="stack">
          <h2 className="section-title">Machine credentials</h2>
          <Ruled
            label="Machine credentials"
            template="minmax(0, 1fr) minmax(0, 1.4fr) 64px 104px 104px 104px"
            rows={read.data.minted}
            keyOf={(m) => `${m.owner}:${m.kind}`}
            columns={MINTED}
          />
        </section>
      )}
    </div>
  );
}
