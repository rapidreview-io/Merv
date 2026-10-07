import { useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type {
  RunningAttention,
  RunningUnit,
  RunningUnitArtifact,
  RunningUnitEntry,
  RunningUnitKey,
} from '@merv/contracts/running';
import type { ProcessGraph } from '@merv/workflows/models';
import type { ThreadView } from '@merv/sessions/models';
import { Ago, StatusPill, capital, cx, words } from '../components';
import { Icon } from '../icons';
import { Markdown } from '../markdown';
import { stagesOfGraph } from '../process';
import { Thread, historyEntries, type Handed, type Mark } from '../thread';
import { ArtifactBody, bytes, fileType } from './artifacts';
import { Act } from './running-panel';
import { Reading, Target } from './running-phrase';
import {
  RoleMark,
  StageThreads,
  ThreadDialog,
  groupOf,
  ThreadReading,
  isLive,
  lastActive,
  roleLetter,
  threadFor,
  threadName,
  useThreadList,
  visitCount,
} from './threads';

/**
 * A unit of work on the Work page: its stages with the agents on them, then two columns — on
 * the left what happened, as a narrow history; on the right three tabs. Document is the one
 * thing to read, the unit's key artifact, whole; Agents, every thread of the unit by stage,
 * one read in place; Artifacts, every file of the unit's, one previewed in place. Its owner
 * says which artifact is key, what each entry of the history was and which files are its own
 * (RunningUnit); this page knows no workflow and names none of its states. A document an entry
 * handed in opens in the Document tab in the key artifact's place, until the way back. Each
 * entry's role disc opens the thread that did it.
 */

type Reference = Pick<RunningUnitEntry, 'role' | 'stage' | 'instance' | 'at'>;

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
    <ThreadDialog
      thread={thread}
      group={groupOf(threads, thread)}
      title={title}
      loadedAt={loadedAt}
      onClose={onClose}
    />
  ) : null;
}

/** Each entry's role disc, the way to the thread that did it. */
function marker(
  threads: readonly ThreadView[],
  instance: string | undefined,
  open: (reference: Reference, threadId?: string) => void,
) {
  return (item: RunningUnitEntry): Mark | undefined => {
    if (!item.role) return undefined;
    const elsewhere = !!item.instance && item.instance !== instance;
    const thread =
      item.stage && !elsewhere
        ? threadFor(threads, { stage: item.stage, role: item.role, at: item.at })
        : undefined;
    return {
      letter: roleLetter(item.role),
      label: `${capital(item.role)} thread`,
      ...(thread || (elsewhere && item.stage) ? { onOpen: () => open(item, thread?.id) } : {}),
    };
  };
}

/**
 * The threads of the records inside the unit (a wave's lenses), each read on its own and
 * handed up as it arrives.
 */
function InnerThreads({
  instance,
  onThreads,
}: {
  instance: string;
  onThreads(instance: string, threads: ThreadView[]): void;
}) {
  const { threads, loaded } = useThreadList(instance);
  useEffect(() => {
    if (loaded) onThreads(instance, threads);
  }, [loaded, instance, threads, onThreads]);
  return null;
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

/** Each stage's threads under it, in the program's order, one opened in place on a press. */
function Agents({
  threads,
  names = {},
  order,
  loadedAt,
  opened,
  onOpen,
}: {
  threads: readonly ThreadView[];
  /** What the owner calls each record inside the unit, by its id. */
  names?: Readonly<Record<string, string>>;
  order: readonly string[];
  loadedAt?: string;
  opened?: string;
  onOpen(id: string | undefined): void;
}) {
  const thread = threads.find((item) => item.id === opened);
  if (thread)
    return (
      <div className="unit-tab-body">
        <header className="unit-key-head">
          <button type="button" className="btn-text" onClick={() => onOpen(undefined)}>
            ← Agents
          </button>
          <span className="unit-key-label">{threadName(thread)}</span>
        </header>
        <ThreadReading key={thread.id} thread={thread} loadedAt={loadedAt} />
      </div>
    );
  const rank = (state: string) => {
    const at = order.indexOf(state);
    return at < 0 ? order.length : at;
  };
  const stages = [...new Set(threads.map((item) => item.state))].sort((a, b) => rank(a) - rank(b));
  return (
    <div className="unit-tab-body">
      {stages.map((stage) => (
        <section key={stage} className="unit-group" aria-label={capital(words(stage))}>
          <h3 className="unit-group-head">{capital(words(stage))}</h3>
          <ul className="unit-rows">
            {threads
              .filter((item) => item.state === stage)
              .map((item) => {
                const { visits } = visitCount(item);
                const last = lastActive(item);
                const live = isLive(item);
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="unit-row unit-row--agent"
                      aria-label={threadName(item)}
                      onClick={() => onOpen(item.id)}
                    >
                      <RoleMark role={item.role} />
                      <span className="unit-row-name">
                        {names[item.instanceId] ?? capital(words(item.role))}
                      </span>
                      <span className="unit-row-stage faint">{words(stage)}</span>
                      <span className={cx('unit-row-status', !live && 'faint')}>
                        {live && <span className="live-dot live-dot--live" aria-hidden="true" />}
                        {live ? 'live' : item.status}
                      </span>
                      <span className="faint tabular">
                        {visits} {visits === 1 ? 'visit' : 'visits'}
                      </span>
                      <span className="faint">{last ? <Ago at={last} /> : ''}</span>
                    </button>
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The unit's files, newest first, one previewed in place on a press. */
function Files({
  files,
  opened,
  onOpen,
}: {
  files: readonly RunningUnitArtifact[];
  opened?: string;
  onOpen(id: string | undefined): void;
}) {
  const file = files.find((item) => item.id === opened);
  if (file)
    return (
      <div className="unit-tab-body">
        <header className="unit-key-head">
          <button type="button" className="btn-text" onClick={() => onOpen(undefined)}>
            ← Artifacts
          </button>
        </header>
        <ArtifactBody artifactId={file.id} />
      </div>
    );
  return (
    <ul className="unit-rows unit-tab-body">
      {files.map((item) => {
        const type = fileType(item);
        return (
          <li key={item.id}>
            <button
              type="button"
              className="unit-row unit-row--file"
              onClick={() => onOpen(item.id)}
            >
              <span className="file-glyph" role="img" aria-label={type.label} title={type.label}>
                <Icon name={type.icon} size={14} />
              </span>
              <span className="unit-row-name">{item.title}</span>
              <span className="unit-row-by faint">
                {item.role && <RoleMark role={item.role} />}
                {item.stage && words(item.stage)}
              </span>
              <span className="faint tabular">{item.size !== undefined && bytes(item.size)}</span>
              <span className="faint">{item.at && <Ago at={item.at} />}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

type Tab = 'document' | 'agents' | 'artifacts';
const TABS: Tab[] = ['document', 'agents', 'artifacts'];
/** The tab a reader last chose for this kind of unit, kept in the browser where it can be. */
const tabKey = (kind: string) => `merv:unit-tab:${kind.toLowerCase()}`;
function remembered(kind: string): Tab {
  try {
    const kept = localStorage.getItem(tabKey(kind));
    return TABS.find((tab) => tab === kept) ?? 'document';
  } catch {
    return 'document';
  }
}
function remember(kind: string, tab: Tab) {
  try {
    localStorage.setItem(tabKey(kind), tab);
  } catch {
    // A browser that keeps nothing still switches tabs.
  }
}

export function UnitView({
  unit,
  graph,
  kind,
  title,
  attention,
  wide,
  onRead,
  details,
}: {
  unit: RunningUnit;
  graph?: ProcessGraph;
  /** The unit's kind, under which the reader's tab is remembered. */
  kind: string;
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
  // The records inside the unit have agents of their own, which its Agents tab lists too.
  const [inner, setInner] = useState<ReadonlyMap<string, ThreadView[]>>(new Map());
  const held = useCallback(
    (instance: string, found: ThreadView[]) =>
      setInner((known) =>
        known.get(instance) === found ? known : new Map(known).set(instance, found),
      ),
    [],
  );
  const inside = unit.instances ?? [];
  const agents = [...threads, ...inside.flatMap((instance) => inner.get(instance) ?? [])];
  const [opened, setOpened] = useState<string>();
  const [elsewhere, setElsewhere] = useState<Reference & { instance: string }>();
  const [document, setDocument] = useState<Handed>();
  // The choice made here, for this kind; another kind reads its own remembered tab.
  const [made, setMade] = useState<{ kind: string; tab: Tab }>();
  const chosen = made?.kind === kind ? made.tab : remembered(kind);
  const [agent, setAgent] = useState<string>();
  const [file, setFile] = useState<string>();
  const thread = threads.find((item) => item.id === opened);
  const open = (reference: Reference, threadId?: string) => {
    if (threadId) setOpened(threadId);
    else if (reference.instance) setElsewhere({ ...reference, instance: reference.instance });
  };
  const entries = historyEntries(
    unit.history ?? [],
    nameOf,
    marker(threads, graph?.instanceId, open),
  );
  const key = unit.key;
  // A document from the history stands in the key artifact's place until the way back.
  const showing = document && document.id !== key?.artifact?.id ? document : undefined;
  const ask = attention && !attention.quiet ? attention : undefined;
  const files = unit.artifacts;
  // A tab the unit has nothing for is not drawn, and one remembered for it reads the document.
  const offered = TABS.filter(
    (tab) => (tab !== 'agents' || !!graph) && (tab !== 'artifacts' || !!files),
  );
  const tab = offered.includes(chosen) ? chosen : 'document';
  const choose = (next: Tab) => {
    setMade({ kind, tab: next });
    remember(kind, next);
  };
  const counts: Record<Tab, number | undefined> = {
    document: undefined,
    agents: agents.length,
    artifacts: files?.length,
  };
  const order = graph ? stagesOfGraph(graph).map((step) => step.state) : [];
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
              onDocument={(handed) => {
                choose('document');
                setDocument(handed.id === (showing ?? key?.artifact)?.id ? undefined : handed);
              }}
              shown={tab === 'document' ? (showing ?? key?.artifact)?.id : undefined}
            />
          </section>
        )}
        <section className="unit-reading" aria-label={capital(tab)}>
          {offered.length > 1 && (
            <div className="tabs tabs--strip unit-tabs" role="group" aria-label="Unit">
              {offered.map((each) => (
                <button
                  type="button"
                  key={each}
                  aria-pressed={tab === each}
                  onClick={() => choose(each)}
                >
                  {capital(each)}
                  {counts[each] !== undefined && <span className="state-n">{counts[each]}</span>}
                </button>
              ))}
            </div>
          )}
          {tab === 'agents' ? (
            <Agents
              threads={agents}
              names={unit.names}
              order={order}
              loadedAt={loadedAt}
              opened={agent}
              onOpen={setAgent}
            />
          ) : tab === 'artifacts' && files ? (
            <Files files={files} opened={file} onOpen={setFile} />
          ) : (
            <>
              {ask && <Ask attention={ask} />}
              {showing ? (
                <>
                  <header className="unit-key-head">
                    <button
                      type="button"
                      className="btn-text"
                      onClick={() => setDocument(undefined)}
                    >
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
                      className={cx(
                        'unit-body',
                        !wide && key.text === undefined && 'unit-body--cut',
                      )}
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
            </>
          )}
        </section>
      </div>
      {details}
      {inside.map((instance) => (
        <InnerThreads key={instance} instance={instance} onThreads={held} />
      ))}
      {thread && (
        <ThreadDialog
          thread={thread}
          group={groupOf(threads, thread)}
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
