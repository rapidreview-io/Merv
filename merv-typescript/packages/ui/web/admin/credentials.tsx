import { useTool } from '../api';
import { Ago, cx, toneOf, words } from '../components';
import { In, Lede, Loading, None, Refresh, Tone } from './parts';
import type { AdminCredential, AdminCredentials } from './types';

/** The sections in the order a credential's purpose is read: agents, machines, then the rest. */
const ORDER = [
  'Pi agents',
  'Fleet agents',
  'Fleet machines',
  'Sandbox provider',
  'Platform services',
];
const place = (purpose: string) => (ORDER.indexOf(purpose) + ORDER.length + 1) % (ORDER.length + 1);

function Credential({ c }: { c: AdminCredential }) {
  const failed = c.lastFailure;
  // Another name for the same value, or the same name read by another plugin.
  const shared =
    c.sharedWith.length > 0 &&
    `same as ${c.sharedWith.map((o) => (o.env === c.env ? `${o.plugin} ${o.field}` : o.env)).join(', ')}`;
  return (
    <tr className={cx(c.dead && 'admin-dead')}>
      <td className="mono admin-env">{c.env}</td>
      <td className="admin-fill admin-used" title={`${c.plugin} · ${c.field}`}>
        {c.plugin} <span className="mono faint">{c.field}</span>
      </td>
      <td>
        {c.dead ? (
          <Tone tone="bad">dead</Tone>
        ) : (
          <Tone tone={c.set ? 'ok' : 'bad'}>{c.set ? 'set' : 'missing'}</Tone>
        )}
      </td>
      <td className="admin-fill admin-used" title={shared || undefined}>
        {c.fingerprint ? <span className="mono">{c.fingerprint}</span> : <None />}
        {shared && <span className="faint"> {shared}</span>}
      </td>
      <td className="num">{c.lastChanged ? <Ago at={c.lastChanged} /> : <None />}</td>
      <td className="num" title={c.lastOk ? `${c.lastOk.relay} · ${c.lastOk.model}` : undefined}>
        {c.lastOk ? <Ago at={c.lastOk.at} /> : <None />}
      </td>
      <td
        className="num admin-clip"
        title={
          failed
            ? `${failed.status ?? ''} ${failed.code ?? ''} · ${failed.relay} · ${failed.model}`
            : undefined
        }
      >
        {failed ? (
          <span className="status--bad">
            {failed.code ?? failed.status} <Ago at={failed.at} />
          </span>
        ) : (
          <None />
        )}
      </td>
    </tr>
  );
}

const HEAD = [
  'Credential',
  'Used by',
  'State',
  'Fingerprint',
  'Changed',
  'Last ok',
  'Last failure',
];

export function CredentialsView() {
  const read = useTool<AdminCredentials>('/admin/credentials');
  const data = read.data;
  const groups = [...(data?.groups ?? [])].sort((a, b) => place(a.purpose) - place(b.purpose));
  const all = groups.flatMap((g) => g.credentials);
  return (
    <div className="admin-page">
      <Lede
        title="Credentials"
        facts={
          data && (
            <>
              <span>
                <b>{all.filter((c) => c.set).length}</b> set
              </span>
              {all.some((c) => !c.set) && (
                <span className="status--bad">
                  <b>{all.filter((c) => !c.set).length}</b> missing
                </span>
              )}
              {all.some((c) => c.dead) && (
                <span className="status--bad">
                  <b>{all.filter((c) => c.dead).length}</b> dead
                </span>
              )}
            </>
          )
        }
      >
        <Refresh read={read} />
      </Lede>
      <div className="page-stage stack stack--lg">
        <Loading read={read} columns={6} />
        {data && (
          <div className="admin-surface">
            <table className="admin-table" aria-label="Credentials">
              <thead>
                <tr>
                  {HEAD.map((label, at) => (
                    <th key={label} className={at > 3 ? 'num' : undefined}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              {groups.map((group) => {
                const p = group.provider;
                return (
                  <tbody key={p ? `provider:${p.name}` : group.purpose}>
                    <tr className="admin-group">
                      <th colSpan={HEAD.length} scope="rowgroup">
                        {p ? (
                          <>
                            {p.name} <span className="faint">{p.plugin}</span>{' '}
                            {p.health && (
                              <Tone
                                tone={toneOf(p.health.status)}
                                title={[p.health.message, p.health_reason]
                                  .filter(Boolean)
                                  .join(' · ')}
                              >
                                {words(p.health.status)}
                              </Tone>
                            )}
                            {!p.enabled && <Tone tone="dim">disabled</Tone>}
                            {p.verified_at && (
                              <span className="faint">
                                {' '}
                                verified <Ago at={p.verified_at} />
                              </span>
                            )}
                          </>
                        ) : (
                          group.purpose
                        )}
                      </th>
                    </tr>
                    {group.credentials.map((c) => (
                      <Credential key={`${c.env}:${c.field}`} c={c} />
                    ))}
                    {/* A provider whose key is sealed in its row says which fields it holds. */}
                    {p &&
                      !group.credentials.length &&
                      p.fields.map((field) => (
                        <tr key={field.name}>
                          <td className="mono admin-env">{p.credential_env ?? <None />}</td>
                          <td>
                            {p.plugin} <span className="mono faint">{field.name}</span>
                          </td>
                          <td colSpan={HEAD.length - 2}>
                            {field.present === null ? (
                              <None />
                            ) : (
                              <Tone tone={field.present ? 'ok' : 'bad'}>
                                {field.present ? 'set' : 'missing'}
                              </Tone>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                );
              })}
            </table>
          </div>
        )}
        {data && data.minted.length > 0 && (
          <div className="admin-surface">
            <table className="admin-table" aria-label="Minted credentials">
              <thead>
                <tr>
                  <th>Minted by</th>
                  <th>Kind</th>
                  <th className="num">Live</th>
                  <th className="num">Next expiry</th>
                  <th className="num">Revoked 24h</th>
                  <th className="num">Last issued</th>
                </tr>
              </thead>
              <tbody>
                {data.minted.map((m) => (
                  <tr key={`${m.owner}:${m.kind}`}>
                    <td>{m.owner}</td>
                    <td>{words(m.kind)}</td>
                    <td className="num">{m.live}</td>
                    <td className="num">
                      {m.soonestExpiry ? <In at={m.soonestExpiry} /> : <None />}
                    </td>
                    <td className="num">
                      {Number(m.revokedLastDay) ? m.revokedLastDay : <None />}
                    </td>
                    <td className="num">
                      <Ago at={m.newestIssued} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
