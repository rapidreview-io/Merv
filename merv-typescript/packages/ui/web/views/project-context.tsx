import { useId, useState, type FormEvent } from 'react';
import { useTool, type Project } from '../api';
import { Area, Failure, LoadState } from '../components';
import { useCommand } from '../mutations';
import { useSession } from '../session';

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
  if (!draft)
    return (
      <div>
        <button
          className="btn btn--sm"
          onClick={() =>
            setDraft({ summary: project.summary ?? '', expectedSummary: project.summary ?? '' })
          }
        >
          Edit introduction
        </button>
      </div>
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!conflict || mutation.retry) void mutation.submit(draft);
  };
  return (
    <form className="card stack claims-form" aria-labelledby={heading} onSubmit={submit}>
      <h3 id={heading}>Edit introduction</h3>
      <fieldset disabled={mutation.locked}>
        <Area
          label="Project intent"
          className="textarea"
          rows={6}
          maxLength={16000}
          value={draft.summary}
          onChange={(summary) => setDraft({ ...draft, summary })}
        />
      </fieldset>
      {conflict && (
        <div className="stack" role="alert">
          <p>
            The introduction changed while you were editing. Your draft is preserved. Compare it
            with the current introduction above before trying again.
          </p>
          <button
            type="button"
            className="btn btn--sm"
            disabled={mutation.locked || project.summary === draft.expectedSummary}
            onClick={() => {
              setDraft({ ...draft, expectedSummary: project.summary ?? '' });
              setConflict(false);
            }}
          >
            Keep my draft and use the current introduction as its baseline
          </button>
        </div>
      )}
      <Failure message={mutation.error} />
      <div className="cluster">
        <button
          className="btn btn--primary"
          disabled={mutation.busy || (conflict && !mutation.retry)}
        >
          {mutation.busy ? 'Saving…' : mutation.retry ? 'Retry same request' : 'Edit introduction'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={mutation.locked}
          onClick={() => {
            setDraft(null);
            setConflict(false);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ProjectIntroduction() {
  const { actor } = useSession();
  const project = useTool<Project>('project.get', {}, { every: 8000 });
  return (
    <section className="stack">
      <h2 className="section-title">Project introduction</h2>
      <LoadState {...project} />
      {project.data && (
        <>
          <p className="prose">{project.data.summary || 'No introduction has been set.'}</p>
          <p className="faint">Revision {project.data.contextRevision ?? 0}</p>
          {(actor.role === 'operator' || actor.role === 'producer') && (
            <IntroductionEditor
              key={project.data.id}
              project={project.data}
              onSaved={project.reload}
            />
          )}
        </>
      )}
    </section>
  );
}
