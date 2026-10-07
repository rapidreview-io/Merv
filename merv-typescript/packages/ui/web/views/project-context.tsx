import { Link } from 'react-router-dom';
import type { PaperDocument } from '@merv/paper/models';
import { introductionFrom } from '@merv/paper/rules';
import { useTool } from '../api';
import { EmptyState, LoadState } from '../components';
import { Markdown } from '../markdown';
import { useShell } from '../shell';

/** The project Introduction, which Paper serves from the paper's Problem: edited there. */
export function ProjectIntroduction() {
  const paper = useShell().data?.rows.some((row) => row.view.kind === 'paper');
  const problem = useTool<PaperDocument>(
    paper ? 'paper.read' : null,
    { kind: 'problem' },
    { every: 8000 },
  );
  const text = problem.data ? introductionFrom(problem.data.current) : '';
  return (
    <section className="stack" aria-label="Project introduction">
      <p className="muted">
        Merv writes this from the project paper&apos;s Problem.{' '}
        {paper && <Link to="/paper">Change the Problem in the paper.</Link>}
      </p>
      <LoadState {...problem} />
      {text ? (
        <Markdown source={text} />
      ) : (
        (!paper || problem.data) && (
          <EmptyState kind="settings" icon="file-text" title="No introduction yet" />
        )
      )}
    </section>
  );
}
