import type { ComponentType } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { EmptyState } from '../components';
import type { Row, ShellData } from '../shell';
import { ArtifactsView } from './artifacts';
import { CodeView } from './code';
import { ExperimentsView } from './experiments';
import { FeedView } from './feed';
import { LegacyHistoryView } from './legacy-history';
import { PaperView } from './paper';
import { PiView } from './pi';
import { CollectionView, RecordView } from './remote';
import { ResearchView } from './research';
import { ReflectionsView } from './research-programs';
import { ReviewsView } from './reviews';
import { SessionsView } from './sessions';
import { SettingsView } from './settings';
import { TasksView } from './tasks';
import { WorkView } from './work';

export interface ViewProps {
  row: Row;
  shell: ShellData;
}

/**
 * A moved address goes where its work is now. The thing it named in hand (`?key=`) still
 * opens that thing's sidebar there, and the page a link carried goes with it.
 */
export function Moved({ to }: { to: string }) {
  const { search, state } = useLocation();
  return <Navigate to={{ pathname: to, search }} state={state} replace />;
}

const views: Record<string, ComponentType<ViewProps>> = {
  tasks: TasksView,
  reviews: ReviewsView,
  artifacts: ArtifactsView,
  feed: FeedView,
  settings: SettingsView,
  sessions: SessionsView,
  code: CodeView,
  experiments: ExperimentsView,
  paper: PaperView,
  pi: PiView,
  research: ResearchView,
  reflections: ReflectionsView,
  work: WorkView,
  'legacy-history': LegacyHistoryView,
  // Two generic kinds: a row a remote service describes through its manifest.
  collection: CollectionView,
  record: RecordView,
};

/** Every view kind this build can draw: what an address may open with and still be ours. */
export const VIEW_KINDS: readonly string[] = Object.keys(views);

/** A row whose view kind this bundle does not know still gets a page; it says so instead of breaking. */
function UnknownView({ row }: ViewProps) {
  return (
    <div className="page-stage">
      <EmptyState
        icon="alert"
        title={row.label}
        hint="This version of Merv cannot show this page"
      />
    </div>
  );
}

export const viewFor = (kind: string): ComponentType<ViewProps> => views[kind] ?? UnknownView;
