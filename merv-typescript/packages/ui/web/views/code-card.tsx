import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type {
  CodeBaseCheck,
  CodeBaseControlInput,
  CodeBaseRecord,
  CodeUnit,
} from '@merv/contracts/code-units';
import type { CodeProjectStatus } from '@merv/contracts/code';
import type { CodePublication } from '@merv/contracts/types';
import {
  Ago,
  Area,
  ConfirmAction,
  Failure,
  Field,
  KV,
  KindLabel,
  Short,
  StatusPill,
  Summary,
  cx,
  kindStyle,
  words,
  type KVRow,
} from '../components';
import { ArrowRightIcon, ExternalIcon } from '../icons';
import { RecordLink, type RecordNames } from '../markdown';
import { useCommand } from '../mutations';
import { bytes } from './artifacts';
import { MAIN, sameMerge, waitersOf, type GitModel } from './code-model';
import { UnitCode } from './code-section';

/**
 * What one node on the canvas is, in its own fields: the trunk, a unit of work, the
 * base where accepted commits were merged, or a publication. It is the second of the
 * two boxes this page draws, and it opens where the reader is already looking — beside
 * the drawing where there is room, under the row that was pressed where there is not.
 *
 * Nothing here prints a base key: the digest names nothing to a person, so it reaches
 * the page only in the address that selected the node and in the argument of a control.
 * Every commit is a <Short>, and every unit of work is the record that owns it.
 *
 * The operator's verbs stand on the thing they act on. Each one is behind the guard
 * that names its consequence and takes the reason its tool keeps, and none is drawn
 * for a leased session, because every one of these tools refuses one.
 */

/** The card's place in the page, which the node that opened it scrolls into view. */
const CARD = 'code-props';

/** Who is reading. A session sees the page and none of its verbs. */
export interface Reader {
  /**
   * A project administrator who is not a leased worker, which is what the base and
   * mirror tools require: admin scope and no session.
   */
  manages: boolean;
  /**
   * The same administrator, signed in as a person. Fencing a writer and every
   * publication control refuse a key and a bearer actor outright, so the narrower
   * rule is what draws them.
   */
  signedIn: boolean;
  /** Who accepted or merged, by name; nobody is named by an identifier. */
  named(id: string | null | undefined): string | undefined;
}

/**
 * One operator verb. The guard is the box, because there the box is the object: it
 * says what will change before it acts, keeps the command through an answer that never
 * arrived, and closes only on a confirmed change.
 */
function Verb({
  tool,
  input,
  label,
  title,
  says,
  reason,
  blocked,
  danger,
  onToggle,
  onDone,
  children,
}: {
  tool: string;
  input: Record<string, unknown>;
  label: string;
  title: string;
  /** What this will do, in the words of the tool that will do it. */
  says: ReactNode;
  /** The tool keeps a reason with the record; where it keeps none, none is asked for. */
  reason?: boolean;
  /** What the tool would refuse this for, said here rather than sent to be refused. */
  blocked?: string;
  /** What cannot be undone wears the refusal's colour and never the accent. */
  danger?: boolean;
  onToggle?(open: boolean): void;
  onDone(): void;
  children?: ReactNode;
}) {
  const [why, setWhy] = useState('');
  const [tried, setTried] = useState(false);
  const done = useRef(false);
  const command = useCommand<unknown>({
    tool,
    validate: (value) => !!value && typeof value === 'object',
    onSuccess: () => {
      done.current = true;
      onDone();
    },
  });
  // What is missing is read from the fields themselves rather than latched, so the
  // sentence goes the moment the operator has answered it.
  const missing =
    blocked ??
    (reason && !why.trim()
      ? 'This reason is kept with the record, so it cannot be empty.'
      : undefined);
  const control = (
    <ConfirmAction
      label={label}
      title={title}
      confirm={command.retry ? 'Retry same request' : label}
      busy={command.busy ? 'Working…' : undefined}
      danger={!!danger}
      onToggle={onToggle}
      note={<Failure message={command.error ?? (tried ? missing : undefined)} />}
      onConfirm={async () => {
        if (missing) {
          setTried(true);
          return false;
        }
        setTried(false);
        done.current = false;
        await command.submit({ ...input, ...(reason ? { reason: why.trim() } : {}) });
        return done.current;
      }}
    >
      <p>{says}</p>
      {children}
      {reason && (
        <Area label="Reason" value={why} onChange={setWhy} rows={2} maxLength={2000} required />
      )}
    </ConfirmAction>
  );
  return danger ? <span className="act-danger">{control}</span> : control;
}

/**
 * What may still be done to a base, which is the server's own rule rather than a guess:
 * only infrastructure work is retried, only a suspended base resumes, and a base that
 * resolved or was cancelled has reached its end. A quarantined base takes nothing at all.
 */
export function verbsOf(base: CodeBaseRecord): CodeBaseControlInput['action'][] {
  if (base.quarantined) return [];
  const open = !['resolved', 'cancelled'].includes(base.state);
  const actions: CodeBaseControlInput['action'][] = [];
  if (open && ['blocked_infra', 'retry_wait'].includes(base.state)) actions.push('retry');
  if (open && base.state !== 'suspended') actions.push('suspend');
  if (open && base.state === 'suspended') actions.push('resume');
  if (open) actions.push('cancel');
  actions.push('quarantine');
  return actions;
}

const SAID: Record<CodeBaseControlInput['action'], [string, string, string]> = {
  retry: [
    'Retry merge',
    'Retry this merge?',
    'The server tries this base’s infrastructure work again with five new attempts. Nothing already merged changes.',
  ],
  suspend: [
    'Suspend merge',
    'Suspend this merge?',
    'The base stops where it is and keeps its work and its history. Everything waiting behind it goes on waiting until it is resumed.',
  ],
  resume: [
    'Resume merge',
    'Resume this merge?',
    'The base goes back to the state it was suspended in. A resolution task suspended by its review budget still needs that limit extended.',
  ],
  cancel: [
    'Cancel merge',
    'Cancel this merge permanently?',
    'This base is never made. Everything waiting behind it needs corrective work and a new plan.',
  ],
  quarantine: [
    'Quarantine base',
    'Quarantine this base and everything under it?',
    'Nothing may be built on this base or its descendants again, including the pins and acceptances already made from it. Its result stays retained and cannot be reused.',
  ],
};

/**
 * A commit that went into a merge, said as the record that was accepted with it. The
 * name and its commit are one value and hug each other, so a column of them reads as
 * one commit per line and not as twice as many facts.
 */
const Member = ({
  commit,
  unit,
  names,
}: {
  commit: string;
  unit?: CodeUnit;
  names: RecordNames;
}) => (
  <span className="cluster code-member">
    {unit ? <RecordLink id={unit.unitId} names={names} /> : null}
    <Short value={commit} />
  </span>
);

/** What one line can say about a verdict: how it ended, where, how long and what it cost. */
function checkSaid(base: CodeBaseRecord): string {
  const receipt = base.check?.receipt;
  if (!receipt)
    return base.checkState === 'unavailable'
      ? `not run: ${base.blocker ?? 'no sandbox adapter'}`
      : (base.check?.reason ?? 'waiting for a machine');
  const ran =
    receipt.startedAt && receipt.finishedAt
      ? `${Math.max(0, Math.round((Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt)) / 1000))}s`
      : 'unmeasured';
  const machine = receipt.environment
    ? `${receipt.environment.provider} ${receipt.environment.offerId}${receipt.environment.snapshotId ? ` · ${receipt.environment.snapshotId}` : ''}`
    : 'an unrecorded machine';
  const cost = receipt.usage ? ` · ${receipt.usage.amount} ${receipt.usage.currency}` : '';
  return `${receipt.timedOut ? 'timed out' : `exit ${receipt.exitCode}`} · ${ran} · ${machine}${cost}`;
}

/** The head and tail the receipt kept, with the gap between them named rather than hidden. */
function printed(receipt: NonNullable<CodeBaseCheck['receipt']>): string {
  const kept = receipt.output.head.length + receipt.output.tail.length;
  const gap =
    receipt.output.bytes > kept ? `\n… ${receipt.output.bytes - kept} bytes omitted …\n` : '\n';
  return (
    `${receipt.output.head}${gap}${receipt.output.tail}`.trim() || 'The command printed nothing.'
  );
}

function BaseBody({
  base,
  model,
  units,
  names,
  manages,
  onDone,
}: {
  base: CodeBaseRecord;
  model: GitModel;
  units: CodeUnit[];
  names: RecordNames;
  manages: boolean;
  onDone(): void;
}) {
  const [open, setOpen] = useState<CodeBaseControlInput['action'] | null>(null);
  const of = (commit: string) => units.find((unit) => unit.acceptance?.reference === commit);
  const parents = (base.parents ?? []).flatMap((commit) => (commit ? [commit] : []));
  const waiters = waitersOf(base, units);
  const resolver = base.resolutionTaskId;
  const rows: KVRow[] = [
    !!base.members.length && [
      'Made from',
      <span className="stack code-members">
        {base.members.map((commit) => (
          <Member key={commit} commit={commit} unit={of(commit)} names={names} />
        ))}
      </span>,
    ],
    // The two commits the merge actually joined, which is what makes the frozen pairwise
    // plan a small tree rather than a flat fan. On the ordinary pairwise merge they are
    // the members themselves, and the card does not say its one fact twice.
    !!parents.length &&
      !sameMerge(parents, base.members) && [
        'Joined',
        <span className="stack code-members">
          {parents.map((commit) => (
            <Member key={commit} commit={commit} unit={of(commit)} names={names} />
          ))}
        </span>,
      ],
    !!base.result && [
      'Result',
      <span className="cluster">
        <Short value={base.result.commit} />
        <span className="muted">
          {base.result.method === 'auto' ? 'merged automatically' : 'merged by a task'}
        </span>
      </span>,
    ],
    // A check the base never reached says nothing; every other state is on the card, so a
    // verdict and what the machine could not isolate are read in the same place.
    base.checkState !== 'none' && [
      'Project check',
      <span className="cluster">
        <StatusPill value={words(base.checkState)} />
        {!!base.check?.spec && <code className="mono">{base.check.spec.command}</code>}
        <span className="muted">{checkSaid(base)}</span>
      </span>,
    ],
    !!base.check?.receipt && [
      'Check output',
      <span className="stack stack--tight">
        <pre className="mono code-check-output">{printed(base.check.receipt)}</pre>
        {base.check.receipt.isolation.facts.map((fact) => (
          <span className="muted" key={fact}>
            {fact}
          </span>
        ))}
      </span>,
    ],
    !!base.conflict?.paths.length && [
      'Conflicting paths',
      <span className="stack stack--tight">
        {base.conflict.paths.map((path) => (
          <code className="mono" key={path}>
            {path}
          </code>
        ))}
      </span>,
    ],
    // Every record this card names is named the one way: a link to the record itself.
    !!resolver && [
      'Resolved by',
      <span className="cluster">
        <RecordLink id={resolver} names={names} />
        <StatusPill value={model.word.get(resolver) ?? null} />
      </span>,
    ],
    !!waiters.length && [
      'Waiting on it',
      <span className="cluster">
        {waiters.map((id) => (
          <RecordLink key={id} id={id} names={names} />
        ))}
      </span>,
    ],
    !!base.operatorReason && ['Operator reason', base.operatorReason],
  ];
  return (
    <>
      <KV rows={rows} />
      {manages && (
        <div className="cluster code-verbs">
          {/* While a guard is open it is the only verb drawn, so no other sentence's
              control stands a press away from this one's confirmation. */}
          {verbsOf(base)
            .filter((action) => !open || open === action)
            .map((action) => {
              const [label, title, says] = SAID[action];
              return (
                <Verb
                  key={action}
                  tool={`code.base.${action}`}
                  input={{ key: base.key }}
                  label={label}
                  title={title}
                  says={says}
                  reason
                  danger={action === 'cancel' || action === 'quarantine'}
                  onToggle={(on) => setOpen(on ? action : null)}
                  onDone={onDone}
                />
              );
            })}
        </div>
      )}
    </>
  );
}

function PublishedBody({
  published,
  model,
  onSelect,
}: {
  published: CodePublication;
  model: GitModel;
  onSelect(id: string): void;
}) {
  const pull = published.pull;
  // The wave that replaced this one is a ring on this very drawing, so it is named by
  // its own title and selected by pressing it — never printed as the id it is keyed by.
  const successor = model.nodes.find((node) => node.id === published.successor);
  return (
    <>
      <KV
        rows={[
          [
            'Branch',
            <span className="cluster">
              <code className="mono">{published.branch}</code>
              <ArrowRightIcon size={12} />
              <code className="mono">{published.baseBranch}</code>
            </span>,
          ],
          !!published.review && ['Review', <StatusPill value={words(published.review.verdict)} />],
          !!pull && [
            'Pull request',
            <a className="btn-text" href={pull.url} target="_blank" rel="noreferrer">
              {pull.title} <ExternalIcon size={14} />
            </a>,
          ],
          !!(published.merge?.commitSha ?? pull?.mergeCommitSha) && [
            'Merged',
            <Short value={(published.merge?.commitSha ?? pull?.mergeCommitSha)!} />,
          ],
          !!published.stale && [
            'Superseded',
            successor ? (
              <button type="button" className="btn-text" onClick={() => onSelect(successor.id)}>
                {successor.name}
              </button>
            ) : (
              'by a later wave'
            ),
          ],
        ]}
      />
      {/* What the published repository holds and this server did not write is the one
          thing here drawn in the refusal's colour. */}
      {!!published.incident && (
        <p className="code-refusal">
          The published branch moved to a commit Merv did not write, at{' '}
          <Ago at={published.incident.at} />.
        </p>
      )}
      {!!published.lastError && <p className="code-refusal">{published.lastError}</p>}
    </>
  );
}

export function CodeCard({
  id,
  model,
  status,
  publications,
  names,
  manages,
  signedIn,
  named,
  head = true,
  onSelect,
  onDone,
}: Reader & {
  id: string;
  model: GitModel;
  status?: CodeProjectStatus;
  publications: CodePublication[];
  names: RecordNames;
  /** False where the row this opened under is already the head, so it is said once. */
  head?: boolean;
  onSelect(id: string | null): void;
  onDone(): void;
}) {
  useEffect(() => {
    document.getElementById(CARD)?.scrollIntoView?.({ block: 'nearest' });
  }, [id]);
  const node = model.nodes.find((item) => item.id === id);
  if (!node) return null;
  const units = status?.units ?? [];
  const unit = units.find((item) => item.unitId === id);
  const base = (status?.bases ?? []).find((item) => item.key === id);
  const published = publications.find((item) => item.proposalId === id);
  const main = status?.project;
  const open = node.to && (
    <Link className="map-open" to={node.to}>
      Open record <ArrowRightIcon size={14} />
    </Link>
  );
  return (
    <div
      className={cx('record', 'code-card', node.hollow && 'code-refused')}
      id={CARD}
      role="region"
      aria-live="polite"
      aria-label={node.name}
      style={kindStyle(node.colour)}
    >
      {head && (
        <>
          <KindLabel kind={node.colour} />
          <strong className="code-card-name">{node.name}</strong>
          <StatusPill value={model.word.get(node.id) ?? null} />
        </>
      )}
      {id === MAIN && main && (
        <KV
          rows={[
            ['Commit', <Short value={main.main.oid} />],
            ['Admitted', <Ago at={main.main.admittedAt} />],
            [
              'Kept',
              main.durability === 'code'
                ? 'in the repository this server keeps'
                : 'on the runner that made it',
            ],
            // Rebinding has no UI of its own, like binding; what the card shows is the whole
            // lineage, newest first, because work accepted under any repository the project
            // was bound to is still its own and this is the only screen that says so. One row
            // rather than one per entry: a KV row is keyed by its label. A server that predates
            // the lineage sends no `previous` at all, so it is read as a value that may be
            // missing rather than one the page can rely on.
            !!main.previous?.length && [
              'Rebound',
              <>
                {[...main.previous].reverse().map((entry) => (
                  <div key={entry.operationId}>
                    from <Short value={entry.repositoryId} /> <Ago at={entry.reboundAt} /> —{' '}
                    {/* The reason is the operator's own, up to 4000 characters: the line keeps
                        its length and the hover keeps the whole of it. */}
                    <span title={entry.reason}>
                      {entry.reason.length > 120 ? `${entry.reason.slice(0, 120)}…` : entry.reason}
                    </span>
                  </div>
                ))}
              </>,
            ],
          ]}
        />
      )}
      {!!unit && (
        <>
          <UnitCode unit={unit} named={named} open={open} />
          {/* The one verb a stuck writer needs, where the writer is read. Its tool is the
              one here that asks for a person rather than an administrator: a key and a
              bearer actor are refused by the server, so neither is offered it. */}
          {signedIn && unit.writerState === 'recovery_required' && (
            <Verb
              tool="code.unit.fence"
              input={{ unitId: unit.unitId }}
              label="Fence the writer"
              title="End this writer generation?"
              says="The unit closes at the last commit Code admitted. Whatever the machine was still sending is kept on the server and never admitted, and the next lease continues from that commit."
              onDone={onDone}
            />
          )}
        </>
      )}
      {!!base && (
        <BaseBody
          base={base}
          model={model}
          units={units}
          names={names}
          manages={manages}
          onDone={onDone}
        />
      )}
      {!!published && <PublishedBody published={published} model={model} onSelect={onSelect} />}
      {!unit && open}
    </div>
  );
}

/**
 * The machinery, folded: what the server is moving, what it refused, how far the
 * published repository is behind and what it is keeping on disk. It is configuration
 * and repair rather than the picture, so it stays possible without being prominent.
 */
export function CodeOperations({
  status,
  manages,
  onDone,
}: {
  status?: CodeProjectStatus;
  manages: boolean;
  onDone(): void;
}) {
  const moving = (status?.operations ?? []).filter((item) => item.status === 'prepared');
  const refused = (status?.operations ?? []).filter((item) => item.status === 'failed');
  const warnings = status?.warnings ?? [];
  const mirror = status?.mirror;
  const store = status?.store;
  const blocked = mirror?.blockedRefs ?? [];
  const rows: KVRow[] = [
    !!mirror && [
      'Publishing',
      <span className="cluster">
        <StatusPill value={mirror.state} />
        {/* Publishing is off and nothing is published for a reason the server states;
            the one configuration this fold exists to mend says why, not just that. */}
        {mirror.repository ? (
          <span className="mono">{mirror.repository}</span>
        ) : mirror.blockedBy ? (
          <span className="muted">{words(mirror.blockedBy)}</span>
        ) : null}
        {!!mirror.oldestPendingAt && (
          <span className="muted">
            waiting since <Ago at={mirror.oldestPendingAt} />
          </span>
        )}
      </span>,
    ],
    // The refusal is a code the server keeps, and is read here as the refused transfers
    // three rows below are read, rather than one line of machine text beside them.
    !!mirror?.lastError && ['Last refusal', words(mirror.lastError)],
    !!store?.hosted && ['Disk', `${bytes(store.diskBytes)} of ${bytes(store.quotaBytes)}`],
    // How old the off-host copy is, which is how much work a lost disk would cost. Its
    // trouble is already a warning on the project, so this line says only what was written —
    // except that copies configured and never taken must not read as no copies at all.
    !!store?.backup && [
      'Backup',
      store.backup.at === null ? (
        'never'
      ) : (
        <span className="cluster">
          <span>{bytes(store.backup.bytes)}</span>
          <Ago at={store.backup.at} className="muted" />
        </span>
      ),
    ],
  ];
  // A fold that opens onto nothing promises machinery it does not hold.
  if (
    !rows.some(Boolean) &&
    !blocked.length &&
    !moving.length &&
    !refused.length &&
    !warnings.length
  )
    return null;
  return (
    <details className="code-ops">
      <Summary>Operations</Summary>
      <div className="stack">
        <KV rows={rows} />
        {blocked.map((ref) => (
          <div className="cluster code-ops-row" key={ref.operationId}>
            <code className="mono">{ref.ref}</code>
            <span className="muted">{ref.message}</span>
            <Ago at={ref.at} className="faint" />
            {manages && <MirrorRef blocked={ref} onDone={onDone} />}
          </div>
        ))}
        {moving.map((item) => (
          <div className="cluster code-ops-row" key={item.id}>
            <span>{words(item.kind)}</span>
            {!!item.phase && <span className="muted">{words(item.phase)}</span>}
            <span className="faint">
              {bytes(item.received)}
              {item.bytes === null ? '' : ` of ${bytes(item.bytes)}`}
            </span>
            {!!item.waiting && <span className="muted">{item.waiting.message}</span>}
          </div>
        ))}
        {refused.map((item) => (
          <div className="cluster code-ops-row code-refusal" key={item.id}>
            <span>{words(item.kind)}</span>
            <span>{words(item.error ?? 'refused')}</span>
            {item.findings.map((finding) => (
              <code className="mono" key={`${finding.rule}${finding.path ?? ''}`}>
                {finding.path ?? words(finding.rule)}
              </code>
            ))}
            {!!item.completedAt && <Ago at={item.completedAt} className="faint" />}
          </div>
        ))}
        {warnings.map((warning) => (
          <div className="cluster code-ops-row" key={`${warning.code}${warning.at}`}>
            <span className="muted">{warning.message}</span>
            <Ago at={warning.at} className="faint" />
          </div>
        ))}
      </div>
    </details>
  );
}

/**
 * One ref the published repository has not taken. A ref that holds a commit this server
 * did not write is somebody's work: it is put back in the queue only against the commit
 * the operator says they kept, which is the acknowledgement the tool requires.
 */
function MirrorRef({
  blocked,
  onDone,
}: {
  blocked: NonNullable<CodeProjectStatus['mirror']>['blockedRefs'][number];
  onDone(): void;
}) {
  const [remote, setRemote] = useState('');
  const diverged = blocked.code === 'code_mirror_diverged';
  return (
    <Verb
      tool="code.mirror.retry"
      input={{
        operationId: blocked.operationId,
        ...(diverged && remote.trim() ? { acknowledgeRemote: remote.trim() } : {}),
      }}
      label="Retry mirror"
      title="Publish this ref again?"
      says="The ref goes back in the queue. Work branches only ever fast-forward, and nothing here forces or deletes anything the repository already holds."
      // The server refuses a diverged ref without exactly the commit it found there, so
      // the requirement is said here rather than sent to be refused.
      blocked={
        diverged && !remote.trim()
          ? 'The published ref holds a commit Code did not write; name it once you have kept it somewhere.'
          : undefined
      }
      onDone={onDone}
    >
      {diverged && (
        <Field
          label="The commit you kept"
          className="mono"
          value={remote}
          onChange={setRemote}
          spellCheck={false}
        />
      )}
    </Verb>
  );
}
