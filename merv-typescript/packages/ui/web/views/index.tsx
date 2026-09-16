import type { ComponentType } from 'react';
import type { Row, ShellData } from '../shell';
import { TasksView } from './tasks';
import { ReviewsView } from './reviews';
import { ArtifactsView } from './artifacts';
import { FeedView, ActivityView } from './feed';
import { PeopleView } from './people';
import { ConnectionsView } from './connections';
import { SessionsView } from './sessions';
import { CodeView } from './code';
import { ClaimsView } from './claims';
import { ExperimentsView } from './experiments';
import { SettingsView } from './settings';
import { KnowledgeView } from './knowledge';
import { PaperView } from './paper';
import { ResearchView } from './research';
import { ReflectionsView, ConsolidationView } from './research-programs';
import { LegacyHistoryView } from './legacy-history';

export interface ViewProps {
  row: Row;
  shell: ShellData;
}

const views: Record<string, ComponentType<ViewProps>> = {
  tasks: TasksView,
  reviews: ReviewsView,
  artifacts: ArtifactsView,
  feed: FeedView,
  activity: ActivityView,
  people: PeopleView,
  connections: ConnectionsView,
  settings: SettingsView,
  sessions: SessionsView,
  code: CodeView,
  claims: ClaimsView,
  experiments: ExperimentsView,
  knowledge: KnowledgeView,
  paper: PaperView,
  research: ResearchView,
  reflections: ReflectionsView,
  consolidation: ConsolidationView,
  'legacy-history': LegacyHistoryView,
};

/** A row whose view kind this bundle does not know still gets a page; it says so instead of breaking. */
function UnknownView({ row }: ViewProps) {
  return (
    <div className="page-stage">
      <div className="empty-state">
        <h2>{row.label}</h2>
        <p>
          This build of the UI cannot render view kind <span className="mono">{row.view.kind}</span>
          .{row.readable ? ' The row exposes data through ui.read.' : ''}
        </p>
      </div>
    </div>
  );
}

export const viewFor = (kind: string): ComponentType<ViewProps> => views[kind] ?? UnknownView;
