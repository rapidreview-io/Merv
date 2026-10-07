import { useContext, useEffect, useState, type ReactNode } from 'react';
import type {
  RunningAttention,
  RunningUnit,
  RunningUnitEntry,
  RunningUnitKey,
} from '@merv/contracts/running';
import type { ProcessGraph } from '@merv/contracts/workflow-guidance';
import type { ThreadView } from '@merv/sessions/models';
import { StatusPill, cx } from '../components';
import { Markdown } from '../markdown';
import { Thread, type Entry, type Handed } from '../thread';
import { ArtifactBody } from './artifacts';
import { Act } from './running-panel';
import { Reading, Target } from './running-phrase';
import { StageThreads, ThreadDialog, roleLetter, threadFor, useThreadList } from './threads';

/**
 * A unit of work on the Work page: its stages with the agents on them, then two columns — on
 * the left what happened, as a narrow history; on the right the one thing to read, the unit's
 * key artifact, whole. Its owner says which artifact that is and what each entry of the
 * history was (RunningUnit); this page knows no workflow and names none of its states. A
 * document an entry handed in opens on the right in the key artifact's place, until the way
 * back. Each entry's role disc opens the thread that did it.
 */

type Reference = Pick<RunningUnitEntry, 'role' | 'stage' | 'instance' | 'at'>;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A thread of another record than the unit's own (a lens of a wave): read when its disc is
 * pressed, and opened once it is found.
 */
function ElsewhereDialog({
  reference,
  title,
  onClose,
}: {
  reference: Reference & { instance: string };
  title: string;
  onClose(): void;
}) {
  const { threads, loadedAt, loaded } = useThreadList(reference.instance);
  const thread = threadFor(threads, {
    ...reference,
    stage: reference.stage!,
    role: reference.role!,
  });
  useEffect(() => {
    if (loaded && !thread) onClose();
  }, [loaded, thread, onClose]);
  return thread ? (
    <ThreadDialog thread={thread} title={title} loadedAt={loadedAt} onClose={onClose} />
  ) : null;
}

/** The owner's history as the shared thread draws it, each disc the way to its thread. */
function entriesOf(
  history: readonly RunningUnitEntry[],
  threads: readonly ThreadView[],
  instance: string | undefined,
  nameOf: (id: string) => string | undefined,
  open: (reference: Reference, threadId?: string) => void,
): Entry[] {
  return history.map((item, at): Entry => {
    const who = item.actor ? nameOf(item.actor) : undefined;
    const elsewhere = !!item.instance && item.instance !== instance;
    const thread =
      item.role && item.stage && !elsewhere
        ? threadFor(threads, { stage: item.stage, role: item.role, at: item.at })
        : undefined;
    const mark = item.role && {
      letter: roleLetter(item.role),
      label: `${capital(item.role)} thread`,
      ...(thread || (elsewhere && item.stage) ? { onOpen: () => open(item, thread?.id) } : {}),
    };
    const key = `${at}`;
    if (item.role && item.at)
      return {
        kind: 'post',
        key,
        role: item.role === 'producer' ? 'Producer' : 'Reviewer',
        who,
        at: item.at,
        said: item.said,
        mark: mark || undefined,
        document: item.artifact,
        verdict: item.verdict && { ...item.verdict, review: item.review },
      };
    return {
      kind: 'line',
      key,
      said: item.said ?? '',
      who,
      at: item.at,
      // The way to a review still open is its Review section's, under Details.
      mark: mark || undefined,
      attention: item.attention,
    };
  });
}

/** Lenses, perspectives, parts: a line each, and the one pressed opened under the list. */
function Parts({ parts }: { parts: NonNullable<RunningUnitKey['parts']> }) {
  const { nameOf } = useContext(Reading);
  // The newest report is open to begin with, so there is something to read at once.
  const [opened, setOpened] = useState(
    () => parts.filter((part) => part.artifact).at(-1)?.artifact?.id,
  );
  const shown = parts.find((part) => part.artifact?.id === opened);
  return (
    <div className="stack">
      <ul className="unit-parts">
        {parts.map((part, at) => {
          const who = part.actor ? nameOf(part.actor) : undefined;
          const line = (
            <>
              <span className="unit-part-name">{part.title}</span>
              {who && <span className="faint">{who}</span>}
              <StatusPill value={part.state} />
            </>
          );
          return (
            <li key={at}>
              {part.artifact ? (
                <button
                  type="button"
                  className="unit-part"
                  aria-pressed={opened === part.artifact.id}
                  onClick={() =>
                    setOpened(opened === part.artifact!.id ? undefined : part.artifact!.id)
                  }
                >
                  {line}
                </button>
              ) : (
                <span className="unit-part">{line}</span>
              )}
            </li>
          );
        })}
      </ul>
      {shown?.artifact && <ArtifactBody artifactId={shown.artifact.id} />}
    </div>
  );
}

/** A structured plan's items: each its key, its kind, its title and what it waits on. */
function Items({ items }: { items: NonNullable<RunningUnitKey['items']> }) {
  return (
    <ol className="unit-items">
      {items.map((item) => (
        <li key={item.key}>
          <span className="unit-item-head">
            <span className="mono faint">{item.key}</span>
            <span className="running-kind">{item.kind}</span>
          </span>
          <span className="unit-item-title">{item.title}</span>
          {!!item.dependsOn?.length && (
            <span className="faint">after {item.dependsOn.join(', ')}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** The key artifact's body, whichever one its owner sent. */
function Body({ of }: { of: RunningUnitKey }) {
  if (of.artifact) return <ArtifactBody artifactId={of.artifact.id} />;
  if (of.text !== undefined) return <Markdown source={of.text} under={3} />;
  if (of.parts) return <Parts parts={of.parts} />;
  if (of.items) return <Items items={of.items} />;
  return null;
}

/** Checks, met or still open, one short line each. */
function Checks({ checks }: { checks: NonNullable<RunningUnit['checks']> }) {
  const met = checks.filter((check) => check.met).length;
  return (
    <section className="unit-checks" aria-label="Checks">
      <h3 className="running-section-head">
        <span className="running-section-title">Checks</span>
        <span className="running-aside">
          {met} of {checks.length}
        </span>
      </h3>
      <ul>
        {checks.map((check, at) => (
          <li key={at} className={cx(check.met && 'unit-check--met')}>
            <span className="unit-check-mark" aria-label={check.met ? 'Met' : 'Open'} role="img">
              {check.met ? '✓' : '○'}
            </span>
            <span>{check.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What the owner waits on a person for, as one line with its move: who ends the wait, the
 * control the owner offers, and the way to where it is made.
 */
function Ask({ attention }: { attention: RunningAttention }) {
  return (
    <div className="unit-ask" role="note">
      <span className="running-attn">{attention.who ?? 'Needs you'}</span>
      {attention.action && <Act action={attention.action} />}
      {attention.to && (
        <Target to={attention.to} className="hit">
          {attention.to.text}
        </Target>
      )}
    </div>
  );
}

export function UnitView({
  unit,
  graph,
  title,
  attention,
  wide,
  onRead,
  details,
}: {
  unit: RunningUnit;
  graph?: ProcessGraph;
  /** The unit's name, under which a thread's dialog is titled. */
  title: string;
  /** What needs a person, where the owner said so: one line at the head of the reading. */
  attention?: RunningAttention;
  /** Whether the page gives the unit its whole width, the history beside the reading. */
  wide: boolean;
  /** Narrow, the reading is cut short and this gives it the page. */
  onRead?(): void;
  details?: ReactNode;
}) {
  const { nameOf } = useContext(Reading);
  const { threads, loadedAt } = useThreadList(graph?.instanceId);
  const [opened, setOpened] = useState<string>();
  const [elsewhere, setElsewhere] = useState<Reference & { instance: string }>();
  const [document, setDocument] = useState<Handed>();
  const thread = threads.find((item) => item.id === opened);
  const open = (reference: Reference, threadId?: string) => {
    if (threadId) setOpened(threadId);
    else if (reference.instance) setElsewhere({ ...reference, instance: reference.instance });
  };
  const entries = entriesOf(unit.history ?? [], threads, graph?.instanceId, nameOf, open);
  const key = unit.key;
  // A document from the history stands in the key artifact's place until the way back.
  const showing = document && document.id !== key?.artifact?.id ? document : undefined;
  const ask = attention && !attention.quiet ? attention : undefined;
  return (
    <>
      {graph && (
        <StageThreads graph={graph} threads={threads} loadedAt={loadedAt} onOpen={setOpened} />
      )}
      <div className={cx('unit-columns', wide && 'unit-columns--wide')}>
        {entries.length > 0 && (
          <section className="unit-history" aria-label="History">
            <h3 className="running-section-head">
              <span className="running-section-title">History</span>
            </h3>
            <Thread
              entries={entries}
              onDocument={(handed) =>
                setDocument(handed.id === (showing ?? key?.artifact)?.id ? undefined : handed)
              }
              shown={(showing ?? key?.artifact)?.id}
            />
          </section>
        )}
        <section className="unit-reading" aria-label={showing?.title ?? key?.label ?? 'Reading'}>
          {ask && <Ask attention={ask} />}
          {showing ? (
            <>
              <header className="unit-key-head">
                <button type="button" className="btn-text" onClick={() => setDocument(undefined)}>
                  ← Current
                </button>
                <span className="unit-key-label">{showing.title}</span>
              </header>
              <div className={cx('unit-body', !wide && 'unit-body--cut')}>
                <ArtifactBody artifactId={showing.id} />
              </div>
            </>
          ) : (
            key && (
              <>
                <header className="unit-key-head">
                  <span className="unit-key-label">{key.label}</span>
                  <StatusPill value={key.state} />
                </header>
                <div
                  className={cx('unit-body', !wide && key.text === undefined && 'unit-body--cut')}
                >
                  <Body of={key} />
                </div>
              </>
            )
          )}
          {!wide && onRead && (showing || key?.artifact || key?.parts || key?.items) && (
            <button type="button" className="btn-text unit-read" onClick={onRead}>
              Read in full
            </button>
          )}
          {!showing && unit.checks && unit.checks.length > 0 && <Checks checks={unit.checks} />}
        </section>
      </div>
      {details}
      {thread && (
        <ThreadDialog
          thread={thread}
          title={title}
          loadedAt={loadedAt}
          onClose={() => setOpened(undefined)}
        />
      )}
      {elsewhere && (
        <ElsewhereDialog
          reference={elsewhere}
          title={title}
          onClose={() => setElsewhere(undefined)}
        />
      )}
    </>
  );
}
