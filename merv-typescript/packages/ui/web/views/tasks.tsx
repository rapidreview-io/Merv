import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { call, refreshTools, scopeVersion, useTool, type Loaded } from '../api';
import { UploadIcon } from '../icons';
import { splitRoutes } from '../list-filters';
import { useCommand } from '../mutations';
import { WORK } from '../navigation';
import { RecordPicker, filePick } from '../record-picker';
import {
  Ago,
  Evidence,
  Failure,
  KV,
  LoadState,
  RecordPage,
  Stamp,
  StatusPill,
  Summary,
  timeRows,
  useArtifacts,
} from '../components';
import { Gate, Relations } from '../process';
import { useActorNames } from './people';
import { DELIVER } from './overview';
import {
  BLANK,
  CriterionRows,
  FindingPill,
  Primary,
  ReviewSummary,
  Unmet,
  drafted,
  type Confirmation,
  type Draft,
  type Drafting,
  type Review,
} from './reviews';
import { WorkList } from './work';
import { MAX_FILE, fileInput, type Artifact } from './artifacts';
import type { ViewProps } from './index';
import type { ProcessGraph, WorkflowDependency } from '@merv/contracts/workflow-guidance';

export interface Task {
  id: string;
  title: string;
  goal: string;
  checks: string[];
  deliveryConfirmations: Confirmation[];
  producerId: string;
  briefId: string;
  deliveryIds: string[];
  /** 2 where a delivery confirms each check by number; 1 on a task older than that. */
  evidenceVersion?: 1 | 2;
  reviewId: string | null;
  workflow: { state: string; revision: number; updatedAt: string };
  failure: { reason: string; actorId: string; createdAt: string } | null;
  dependencies: WorkflowDependency[];
  dependents: WorkflowDependency[];
  createdAt: string;
}

/**
 * What was delivered before the delivery the checks now state. A task keeps only its
 * newest delivery, so an earlier one is read from the review that pinned it: the word
 * that review came back with is the way to its verdict, and the files it pinned still
 * open in place. Newest first, behind one quiet disclosure.
 */
function EarlierDeliveries({ task: t, rounds }: { task: Task; rounds: Review[] }) {
  const artifacts = useArtifacts();
  if (!rounds.length) return null;
  const current = new Set([t.briefId, ...t.deliveryIds]);
  return (
    <details className="crit-file">
      <Summary>
        Earlier deliveries <span className="section-n">{rounds.length}</span>
      </Summary>
      <div className="stack">
        {[...rounds].reverse().map((round) => (
          <div className="stack" key={round.id}>
            <p className="cluster">
              <Link to={`/reviews/${round.id}`}>Review</Link>
              <FindingPill value={round.verdict ?? round.status} />
              <Ago at={round.createdAt} className="muted" />
            </p>
            {round.artifactIds
              .filter((id) => !current.has(id))
              .map((id) => (
                <Evidence key={id} artifactId={id} artifact={artifacts.get(id)} meta />
              ))}
          </div>
        ))}
      </div>
    </details>
  );
}

/** How the server titles the brief it composes from a task's title, goal and checks. */
const COMPOSED = 'Task brief: ';
/** And the confirmations sheet it retains, in the producer's name, with every delivery. */
const CONFIRMED = 'Delivery confirmations: ';
/** task.submit_delivery enumerates exactly these two words for a producer's claim. */
const CLAIMS = ['met', 'not_met'] as const;

/**
 * The way a file gets to the desk from the reader's own disk. A delivery is made of
 * retained files, and a person's work is on their machine until something retains
 * it: the glyph opens the browser's chooser, and each file chosen is retained through
 * artifact.create and handed to the desk, so the move can be made from this page
 * alone. The tool takes no request id, so nothing is sent twice: a file that was
 * refused, or whose answer never came, is named, and the list is read again either way.
 */
function useNewFiles(onMade: (file: Artifact) => void) {
  const chooser = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string>();
  const [refused, setRefused] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const retain = async (chosen: File[]) => {
    const epoch = scopeVersion();
    const here = () => mounted.current && epoch === scopeVersion();
    const failed: string[] = [];
    for (const file of chosen) {
      if (!here()) return;
      if (!file.size || file.size > MAX_FILE) {
        failed.push(`${file.name} must hold between 1 byte and 2 MB.`);
        continue;
      }
      setBusy(file.name);
      try {
        const made = await call<Artifact>('artifact.create', await fileInput(file));
        if (here()) onMade(made);
      } catch (failure) {
        failed.push(
          `${file.name}: ${failure instanceof Error ? failure.message : 'could not be kept.'}`,
        );
      }
      // Kept or not, the list that names files is the one that knows.
      refreshTools('artifact.list');
    }
    if (!here()) return;
    setBusy(undefined);
    setRefused(failed.join(' ') || undefined);
  };
  return {
    control: (
      <>
        <button
          type="button"
          className="btn-icon"
          aria-label="New file"
          title="New file"
          disabled={!!busy}
          onClick={() => chooser.current?.click()}
        >
          <UploadIcon />
        </button>
        <input
          ref={chooser}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const chosen = [...(event.target.files ?? [])];
            // The same file can be chosen again after a refusal: the field forgets it.
            event.target.value = '';
            setRefused(undefined);
            void retain(chosen);
          }}
        />
      </>
    ),
    note: (
      <>
        {busy && (
          <p className="muted agent-help" role="status">
            Uploading {busy}…
          </p>
        )}
        <Failure message={refused} />
      </>
    ),
  };
}

/**
 * The producer's desk. A delivery is the files that carry the work and, for every
 * check, the producer's own word, a sentence and the files that show it; the rows
 * under the desk are where that is written, exactly as a reviewer writes findings on
 * them. Every rule below is task.submit_delivery's own, checked before it is sent,
 * and the desk is drawn only where the record's own gate says this reader may deliver.
 */
function DeliveryDesk({
  task: t,
  files,
  onFiles,
  values,
  onLock,
  onDone,
}: {
  task: Task;
  files: string[];
  onFiles(next: string[] | ((held: string[]) => string[])): void;
  values: Record<number, Draft>;
  /** The rows the desk writes on are not inside it, so it says when they must hold still. */
  onLock(locked: boolean): void;
  onDone(): void;
}) {
  // What may be delivered is retained while the page is open, by the producer's own
  // agent as often as not, so the desk keeps reading the list the page reads once.
  const listed = useTool<Artifact[]>('artifact.list', {}, { every: 10_000 });
  // A file made here is the reader's to deliver at once: it joins the delivery, and is
  // named from what the tool answered until the list that names files has read it.
  const [made, setMade] = useState<Artifact[]>([]);
  const fresh = useNewFiles((file) => {
    setMade((held) => [...held, file]);
    onFiles((held) => [...held, file.id]);
  });
  const desk = useRef<HTMLDivElement>(null);
  const { hash } = useLocation();
  // Now sends the reader here to deliver, so the cursor arrives at the desk's first field.
  useEffect(() => {
    if (hash === `#${DELIVER}`) desk.current?.querySelector('input')?.focus();
  }, [hash]);
  const command = useCommand<Task>({
    tool: 'task.submit_delivery',
    validate: (value) => !!value && value.id === t.id,
    onSuccess: () => {
      onDone();
      // The server retains a sheet of the confirmations with the delivery, so the list
      // that names files is read again with the lists the delivery moved.
      refreshTools('task.list', 'review.list', 'ui.home', 'artifact.list');
    },
  });
  useEffect(() => onLock(command.locked), [onLock, command.locked]);
  const known = new Set((listed.data ?? []).map((file) => file.id));
  const drafts = t.checks.map((_, index) => values[index + 1] ?? BLANK);
  const bare = drafts.findIndex((draft) => !draft.status || !draft.notes.trim());
  const uncited = drafts.findIndex(
    (draft) => draft.status === 'met' && !draft.evidenceIds.some((id) => files.includes(id)),
  );
  const unmet: { text: string; at?: number } | undefined = !files.length
    ? { text: 'Choose the files that carry the work.' }
    : bare >= 0
      ? { text: `Check ${bare + 1} still needs your word and a note.`, at: bare + 1 }
      : uncited >= 0
        ? {
            text: `Check ${uncited + 1} is met, so it must cite a delivered file.`,
            at: uncited + 1,
          }
        : undefined;
  return (
    <div
      className="stack creation claims-form"
      id={DELIVER}
      ref={desk}
      data-draft={files.length > 0 || drafted(values) || command.locked ? '' : undefined}
    >
      <fieldset disabled={command.locked}>
        <div className="desk-files">
          <RecordPicker
            label="Delivered files"
            // What the tool takes as a delivery: the producer's own files, with something in
            // them. A brief is what was asked, never part of what answers it.
            options={[...made.filter((file) => !known.has(file.id)), ...(listed.data ?? [])]
              .filter(
                (file) =>
                  file.createdBy === t.producerId &&
                  file.size > 0 &&
                  file.id !== t.briefId &&
                  !file.title.startsWith(COMPOSED) &&
                  !file.title.startsWith(CONFIRMED),
              )
              .map(filePick)}
            loading={listed.loading}
            none="No files of yours yet"
            value={files}
            onChange={onFiles}
          />
          {fresh.control}
        </div>
        {fresh.note}
      </fieldset>
      <Primary
        label={
          command.retry ? 'Retry same request' : command.busy ? 'Submitting…' : 'Submit delivery'
        }
        help={unmet && <Unmet {...unmet} />}
        error={command.error}
        code={command.code}
        disabled={!!unmet || command.busy}
        onClick={() =>
          void command.submit({
            taskId: t.id,
            artifactIds: files,
            confirmations: drafts.map((draft, index) => ({
              checkNumber: index + 1,
              status: draft.status,
              // A file let go of after it was cited is no longer part of the delivery.
              evidenceIds: draft.evidenceIds.filter((id) => files.includes(id)),
              notes: draft.notes.trim(),
            })),
            expectedRevision: t.workflow.revision,
          })
        }
      />
    </div>
  );
}

/**
 * The page's one section. A check is stated once, in its row, with everything said
 * about it: the producer's claim, the reviewer's finding, the files either cites. The
 * review's own sentence stands over the rows, once, and the source documents fold
 * away under them by name, so nothing a row says is printed a second time further
 * down. A brief somebody wrote is open until something has been delivered; the one
 * the server composes from the title, the goal and the checks says nothing the page
 * has not, and ends in instructions to the agent holding the tool, so it stays shut.
 */
export function TaskChecks({
  task: t,
  reviews,
  draft,
}: {
  task: Task;
  reviews: Loaded<Review[]>;
  /** The producer's desk, while a delivery is being written on these rows. */
  draft?: Drafting;
}) {
  const artifacts = useArtifacts();
  const rounds = (reviews.data ?? []).filter((review) => review.subjectId === t.id);
  const review = rounds.find((item) => item.id === t.reviewId);
  const brief = artifacts.get(t.briefId);
  const composed = !brief || brief.title.startsWith(COMPOSED);
  return (
    <div className="stack stack--lg">
      <div className="stack">
        {t.reviewId && !review && <LoadState loading={reviews.loading} error={reviews.error} />}
        {review && <ReviewSummary review={review} />}
        <CriterionRows
          criteria={t.checks}
          confirmations={t.deliveryConfirmations}
          review={review}
          draft={draft}
        />
      </div>
      <div className="stack">
        <h3 className="ev-role">Files</h3>
        <Evidence
          // Whether it opens is decided once the list has named it, not before.
          key={brief ? 'named' : 'unnamed'}
          artifactId={t.briefId}
          artifact={brief}
          // The page's title is the composed brief's too, so the fold names its part instead.
          label={composed && brief ? 'Brief' : undefined}
          opened={!composed && !t.deliveryIds.length}
          meta
        />
        {t.deliveryIds.map((artifactId) => (
          <Evidence
            key={artifactId}
            artifactId={artifactId}
            artifact={artifacts.get(artifactId)}
            meta
          />
        ))}
        <EarlierDeliveries task={t} rounds={rounds.filter((item) => item.id !== t.reviewId)} />
      </div>
    </div>
  );
}

/**
 * A delivery being written: the desk that stands in the Act slot, and the draft its
 * rows carry in the Checks section under it. The two are drawn in different slots of
 * the page and are one form, so what they share is held here. Neither exists unless
 * the record's own gate says this reader may deliver — the edge the diagram drew.
 */
export function useDelivery(
  t: Task | undefined,
  process: ProcessGraph | undefined,
  onDone: () => void,
): { desk?: ReactNode; draft?: Drafting } {
  const [files, setFiles] = useState<string[]>([]);
  const [values, setValues] = useState<Record<number, Draft>>({});
  const [locked, setLocked] = useState(false);
  const delivers =
    !!t &&
    t.evidenceVersion !== 1 &&
    !!process?.edges.some(
      (edge) => edge.tool === 'task.submit_delivery' && !!edge.status && edge.status !== 'blocked',
    );
  if (!t || !delivers) return {};
  return {
    desk: (
      <DeliveryDesk
        task={t}
        files={files}
        onFiles={setFiles}
        values={values}
        onLock={setLocked}
        onDone={() => {
          setFiles([]);
          setValues({});
          onDone();
        }}
      />
    ),
    draft: {
      words: CLAIMS,
      files,
      values,
      set: (number, value) => setValues((old) => ({ ...old, [number]: value })),
      locked,
    },
  };
}

/** The record and the gate it stands at arrive together, from the row that owns them. */
function TaskDetail({ row }: ViewProps) {
  const { id = '' } = useParams();
  const record = useTool<{ task: Task; process: ProcessGraph }>(
    'ui.read',
    { rowId: row.id, params: { id } },
    { every: 8000 },
  );
  const nameOf = useActorNames();
  const t = record.data?.task;
  // Every round of review this task has been through: the list the wave beside this
  // record already reads, so the newest verdict and the earlier ones cost one answer.
  const reviews = useTool<Review[]>(t?.reviewId ? 'review.list' : null, {}, { every: 8000 });
  const process = record.data?.process;
  const delivery = useDelivery(t, process, record.reload);
  if (!t)
    return (
      <div className="page-stage">
        <LoadState {...record} back={{ to: WORK.path, label: 'Work' }} />
      </div>
    );
  return (
    <RecordPage
      back={<Link to={WORK.path}>← Work</Link>}
      kind={row.view.kind}
      name={t.title}
      standing={t.goal}
      state={<StatusPill value={t.workflow.state} />}
      act={
        process && (
          <Gate graph={process} kind={row.view.kind}>
            {delivery.desk}
          </Gate>
        )
      }
      title="Checks"
      content={<TaskChecks task={t} reviews={reviews} draft={delivery.draft} />}
      history={
        t.failure ? (
          <>
            <h3 className="ev-role">Why this task ended</h3>
            <p className="record-prose">{t.failure.reason}</p>
            <p className="muted">
              {nameOf(t.failure.actorId) && `${nameOf(t.failure.actorId)} · `}
              <Stamp at={t.failure.createdAt} />
            </p>
          </>
        ) : undefined
      }
      related={
        t.dependencies?.length || t.dependents?.length ? (
          <>
            <Relations title="Waits on" items={t.dependencies ?? []} />
            <Relations title="Unblocks" items={t.dependents ?? []} />
          </>
        ) : undefined
      }
      details={
        <KV
          rows={[
            ['Producer', nameOf(t.producerId)],
            ...timeRows(t.createdAt, t.workflow.updatedAt),
          ]}
        />
      }
    />
  );
}

export const TasksView = splitRoutes(WorkList, TaskDetail, WORK.path);
