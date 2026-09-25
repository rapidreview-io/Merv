import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useTool, type Project } from '../api';
import { Area, EmptyState, Failure, LoadState, OpenedForm, Submit, cx } from '../components';
import { Markdown } from '../markdown';
import { useCommand } from '../mutations';
import { useSession } from '../session';

/** A project nobody has introduced yet, and — for whoever may write it — the way to begin. */
const Unwritten = ({ action }: { action?: ReactNode }) => (
  <EmptyState kind="settings" icon="file-text" title="No introduction yet" action={action} />
);

function IntroductionEditor({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const heading = useId();
  const [draft, setDraft] = useState<{ summary: string; expectedSummary: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const mutation = useCommand<Project>({
    tool: 'project.context.update',
    validate: (value) =>
      value?.id === project.id &&
      typeof value.summary === 'string' &&
      Number.isInteger(value.contextRevision),
    onSuccess: () => {
      setDraft(null);
      setConflict(false);
      onSaved();
    },
    conflictCode: 'project_context_conflict',
    onConflict: () => {
      setConflict(true);
      onSaved();
    },
  });
  if (!draft) {
    const opener = (
      <button
        type="button"
        // Offered from the empty state it is the page's one control, and wears the accent.
        className={cx('btn', !project.summary && 'btn--primary')}
        onClick={() =>
          setDraft({ summary: project.summary ?? '', expectedSummary: project.summary ?? '' })
        }
      >
        Edit introduction
      </button>
    );
    // With nothing written the empty state offers the control; otherwise it follows the text.
    return project.summary ? <div>{opener}</div> : <Unwritten action={opener} />;
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!conflict || mutation.retry) void mutation.submit(draft);
  };
  const cancel = () => {
    setDraft(null);
    setConflict(false);
  };
  return (
    <OpenedForm
      className="card stack entry-form"
      aria-labelledby={heading}
      onSubmit={submit}
      onClose={cancel}
      locked={mutation.locked}
    >
      <h2 id={heading}>Edit introduction</h2>
      <fieldset disabled={mutation.locked}>
        <Area
          label="Introduction"
          rows={6}
          maxLength={16000}
          value={draft.summary}
          onChange={(summary) => setDraft({ ...draft, summary })}
        />
      </fieldset>
      {conflict && (
        <div className="stack" role="alert">
          <p>The introduction changed while you were editing. Your draft is preserved.</p>
          <button
            type="button"
            className="btn"
            disabled={mutation.locked || project.summary === draft.expectedSummary}
            onClick={() => {
              setDraft({ ...draft, expectedSummary: project.summary ?? '' });
              setConflict(false);
            }}
          >
            Keep my draft
          </button>
        </div>
      )}
      <Failure message={mutation.error} />
      <div className="cluster">
        <Submit
          label="Save"
          busy={mutation.busy}
          retry={mutation.retry}
          disabled={conflict && !mutation.retry}
        />
        <button type="button" className="btn" disabled={mutation.locked} onClick={cancel}>
          Cancel
        </button>
      </div>
    </OpenedForm>
  );
}

export function ProjectIntroduction() {
  const { actor } = useSession();
  const project = useTool<Project>('project.get', {}, { every: 8000 });
  return (
    <section className="stack" aria-label="Project introduction">
      <p className="muted">
        Every worker's assignment carries this. Merv rewrites it from the Problem each time a
        research cycle starts, so an edit here lasts until then.
      </p>
      <LoadState {...project} />
      {project.data && (
        <>
          {project.data.summary && <Markdown source={project.data.summary} />}
          {actor.role === 'operator' || actor.role === 'producer' ? (
            <IntroductionEditor
              key={project.data.id}
              project={project.data}
              onSaved={project.reload}
            />
          ) : (
            !project.data.summary && <Unwritten />
          )}
        </>
      )}
    </section>
  );
}
