import { KV, ObjId, PageHeader, StatusPill, Table } from '../components';
import { useSession } from '../session';
import type { ViewProps } from './index';
import { ProjectIntroduction } from './project-context';

export function SettingsView({ row, shell }: ViewProps) {
  const { actor, project, signOut } = useSession();
  return (
    <div className="page-stage stack stack--lg">
      <PageHeader
        title={row.label}
        summary="Set the project Introduction and inspect the current session and plugins."
      />
      <ProjectIntroduction />
      <section className="stack">
        <h2 className="section-title">Session</h2>
        <KV
          rows={[
            [
              'Project',
              <>
                {project.name} <ObjId id={project.id} />
              </>,
            ],
            [
              'Actor',
              <>
                {actor.name} <ObjId id={actor.id} />
              </>,
            ],
            ['Role', <StatusPill value={actor.role} />],
            [
              'Token',
              <button type="button" className="btn btn--sm" onClick={signOut}>
                Sign out of this tab
              </button>,
            ],
          ]}
        />
      </section>
      <section className="stack">
        <h2 className="section-title">Plugins</h2>
        {shell.plugins.length === 0 ? (
          <div className="empty">
            The server did not report a plugin table; it is running without the configuration
            loader.
          </div>
        ) : (
          <Table
            rows={shell.plugins}
            keyOf={(p) => p.id}
            columns={[
              {
                key: 'id',
                label: 'Entry',
                render: (p) => <strong className="mono">{p.id}</strong>,
              },
              {
                key: 'name',
                label: 'Module',
                render: (p) => <span className="mono faint">{p.name}</span>,
              },
              {
                key: 'state',
                label: 'State',
                render: (p) => <StatusPill value={p.state} />,
                width: '120px',
              },
            ]}
          />
        )}
      </section>
      <section className="stack">
        <h2 className="section-title">Sidebar rows</h2>
        <Table
          rows={shell.rows}
          keyOf={(r) => r.id}
          columns={[
            { key: 'label', label: 'Row', render: (r) => <strong>{r.label}</strong> },
            { key: 'group', label: 'Group', render: (r) => r.group },
            {
              key: 'kind',
              label: 'View kind',
              render: (r) => <span className="mono faint">{r.view.kind}</span>,
            },
            {
              key: 'status',
              label: 'Status',
              render: (r) => <StatusPill value={r.status.state ?? 'ready'} />,
            },
          ]}
        />
      </section>
    </div>
  );
}
