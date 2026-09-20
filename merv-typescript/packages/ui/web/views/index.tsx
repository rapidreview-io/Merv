import type { ComponentType } from 'react';
import { Navigate } from 'react-router-dom';
import type { Row, ShellData } from '../shell';
import { EmptyState } from '../components';
import { TasksView } from './tasks';
import { ReviewsView } from './reviews';
import { ArtifactsView } from './artifacts';
import { FeedView } from './feed';
import { SessionsView } from './sessions';
import { CodeView } from './code';
import { ClaimsView } from './claims';
import { ExperimentsView } from './experiments';
import { SettingsView } from './settings';
import { PaperView } from './paper';
import { ResearchView } from './research';
import { ReflectionsView, ConsolidationView } from './research-programs';
import { LegacyHistoryView } from './legacy-history';
import { CollectionView, RecordView } from './remote';

export interface ViewProps {
  row: Row;
  shell: ShellData;
}

/** A row whose page this wave retired: its work is elsewhere, so the route goes there. */
const moved = (to: string) => () => <Navigate to={to} replace />;

const views: Record<string, ComponentType<ViewProps>> = {
  tasks: TasksView,
  reviews: ReviewsView,
  artifacts: ArtifactsView,
  feed: FeedView,
  // Who may open the project, and what it is connected to, are settings.
  people: moved('/settings/members'),
  connections: moved('/settings/connections'),
  settings: SettingsView,
  sessions: SessionsView,
  code: CodeView,
  claims: ClaimsView,
  experiments: ExperimentsView,
  // The reference lookup is a control on Claims now; the inventory is the record itself.
  knowledge: moved('/claims'),
  paper: PaperView,
  research: ResearchView,
  reflections: ReflectionsView,
  consolidation: ConsolidationView,
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
