import { Link, Route, Routes, useParams } from 'react-router-dom';
import { useState, type ReactNode } from 'react';
import { useTool } from '../api';
import { ListFilters } from '../list-filters';
import { KV, LoadState, ObjId, PageHeader, StatusPill, Table, relativeTime } from '../components';
import { useActorNames } from './people';
import { ArtifactBody } from './artifacts';
import type { ViewProps } from './index';

export interface Review {
  id: string;
  subjectId: string;
  subjectRevision: number;
  producerId: string;
  artifactIds: string[];
  criteria: string[];
  formatVersion: 1 | 2;
  status: 'requested' | 'started' | 'submitted' | 'superseded';
  reviewerId: string | null;
  verdict: 'pass' | 'needs_changes' | 'fail' | null;
  returnTo?: string;
  notes: string | null;
  synopsis: string | null;
  findings: {
    criterionNumber: number;
    status: 'met' | 'not_met' | 'not_verified' | 'waived';
    evidenceIds: string[];
    notes: string;
  }[];
  evidence: Record<string, unknown>;
  createdAt: string;
}

export function ReviewCard({
  review,
  nameOf,
}: {
  review: Review;
  nameOf(id: string | null | undefined): string | undefined;
}) {
  return (
    <div className="card stack">
      <div className="cluster--between">
        <div className="cluster">
          <StatusPill value={review.status} />
          {review.verdict && <StatusPill value={review.verdict} />}
          {review.findings?.some((item) => item.status === 'waived') && (
            <span className="muted">
              {review.findings.filter((item) => item.status === 'waived').length} waived
            </span>
          )}
        </div>
        <Link to={`/reviews/${review.id}`} className="faint">
          <ObjId id={review.id} />
        </Link>
      </div>
      {review.synopsis && <p aria-label="Review synopsis">{review.synopsis}</p>}
      <KV
        rows={[
          ['Producer', nameOf(review.producerId) ?? <ObjId id={review.producerId} />],
          [
            'Reviewer',
            review.reviewerId ? (
              (nameOf(review.reviewerId) ?? <ObjId id={review.reviewerId} />)
            ) : (
              <span className="faint">unclaimed</span>
            ),
          ],
          ['Subject revision', String(review.subjectRevision)],
          ...(review.returnTo
            ? ([['Return to', <StatusPill value={review.returnTo} />]] as [string, ReactNode][])
            : []),
          ['Requested', <span title={review.createdAt}>{relativeTime(review.createdAt)}</span>],
        ]}
      />
      {review.criteria.length > 0 && (
        <div>
          <div className="label">Criteria</div>
          <ol className="checks">
            {review.criteria.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ol>
        </div>
      )}
      {review.findings?.length > 0 && (
        <section className="stack" aria-label="Review findings">
          <div className="label">Findings from the independent reviewer</div>
          <Table
            rows={review.findings}
            keyOf={(item) => String(item.criterionNumber)}
            columns={[
              {
                key: 'criterion',
                label: 'Criterion',
                render: (item) =>
                  `${item.criterionNumber}. ${review.criteria[item.criterionNumber - 1]}`,
              },
              {
                key: 'result',
                label: 'Result',
                render: (item) =>
                  ({
                    met: 'Met',
                    not_met: 'Not met',
                    not_verified: 'Not verified',
                    waived: 'Waived',
                  })[item.status],
              },
              {
                key: 'notes',
                label: 'Verification / correction',
                render: (item) => <span style={{ whiteSpace: 'pre-wrap' }}>{item.notes}</span>,
              },
              {
                key: 'evidence',
                label: 'Evidence',
                render: (item) =>
                  item.evidenceIds.length
                    ? item.evidenceIds.map((id) => (
                        <div key={id}>
                          <Link to={`/artifacts/${id}`}>
                            <ObjId id={id} />
                          </Link>
                        </div>
                      ))
                    : 'None cited',
              },
            ]}
          />
        </section>
      )}
      {review.notes && (
        <div>
          <div className="label">Notes</div>
          <pre className="doc doc--inline">{review.notes}</pre>
        </div>
      )}
      {review.evidence && Object.keys(review.evidence).length > 0 && (
        <section className="stack" aria-label="Review observations">
          <div className="label">Structured observations</div>
          <pre className="doc doc--inline">{JSON.stringify(review.evidence, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}

function ReviewList({ row }: ViewProps) {
  const list = useTool<Review[]>('review.list');
  const nameOf = useActorNames();
  const [query, setQuery] = useState('');
  const [state, setState] = useState('');
  const search = query.trim().toLowerCase();
  const states = [
    ...new Set([...(list.data ?? []).map((item) => item.status), ...(state ? [state] : [])]),
  ].sort();
  const visible = (list.data ?? []).filter(
    (item) =>
      (!state || item.status === state) &&
      (!search ||
        [
          item.id,
          item.subjectId,
          item.synopsis,
          ...item.criteria,
          item.producerId,
          nameOf(item.producerId),
          item.reviewerId,
          nameOf(item.reviewerId),
        ].some((value) => value?.toLowerCase().includes(search))),
  );
  return (
    <div className="page-stage stack">
      <PageHeader
        title={row.label}
        summary="Independent verdicts on submitted work. A producer never reviews their own submission."
      />
      <LoadState
        loading={list.loading}
        error={list.error}
        empty={list.data?.length === 0}
        emptyTitle="No reviews"
        emptyHint="Reviews appear when work is submitted for independent assessment."
      />
      {list.data && list.data.length > 0 && !list.error && (
        <ListFilters
          noun="reviews"
          placeholder="Summary, work item or person"
          query={query}
          onQueryChange={setQuery}
          state={state}
          onStateChange={setState}
          states={states}
          stateLabel="Status"
          shown={visible.length}
          total={list.data.length}
        />
      )}
      {list.data &&
        list.data.length > 0 &&
        !list.error &&
        !list.loading &&
        visible.length === 0 && (
          <LoadState
            loading={false}
            empty
            emptyTitle="No reviews match these filters"
            emptyHint="Try another search or clear the filters."
          />
        )}
      {visible.length > 0 && !list.error && (
        <Table
          rows={[...visible].reverse()}
          keyOf={(r) => r.id}
          onRow={(r) => r.id}
          columns={[
            {
              key: 'id',
              label: 'Review',
              render: (r) => {
                const summary = r.synopsis || r.criteria[0] || 'Independent review';
                return (
                  <div>
                    <strong title={summary}>
                      {summary.length > 120 ? `${summary.slice(0, 117)}…` : summary}
                    </strong>
                    <div className="faint">
                      <ObjId id={r.id} />
                    </div>
                  </div>
                );
              },
            },
            { key: 'status', label: 'Status', render: (r) => <StatusPill value={r.status} /> },
            {
              key: 'verdict',
              label: 'Verdict',
              render: (r) =>
                r.verdict ? (
                  <div className="cluster">
                    <StatusPill value={r.verdict} />
                    {r.returnTo && <span className="muted">Return to {r.returnTo}</span>}
                    {r.findings?.some((item) => item.status === 'waived') && (
                      <span className="muted">
                        {r.findings.filter((item) => item.status === 'waived').length} waived
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="faint">—</span>
                ),
            },
            {
              key: 'subject',
              label: 'Work item',
              render: (r) => <ObjId id={r.subjectId} />,
            },
            {
              key: 'reviewer',
              label: 'Reviewer',
              render: (r) =>
                r.reviewerId ? (
                  (nameOf(r.reviewerId) ?? <ObjId id={r.reviewerId} />)
                ) : (
                  <span className="faint">unclaimed</span>
                ),
            },
            {
              key: 'when',
              label: 'When',
              render: (r) => <span title={r.createdAt}>{relativeTime(r.createdAt)}</span>,
              width: '90px',
            },
          ]}
        />
      )}
    </div>
  );
}

function ReviewDetail({ row }: ViewProps) {
  const { id = '' } = useParams();
  const review = useTool<Review>('review.get', { reviewId: id });
  const nameOf = useActorNames();
  if (!review.data)
    return (
      <div className="page-stage">
        <LoadState
          loading={review.loading}
          error={review.error}
          back={{ to: row.path, label: row.label }}
        />
      </div>
    );
  const r = review.data;
  return (
    <div className="page-stage stack stack--lg">
      <PageHeader
        eyebrow={<Link to={row.path}>← {row.label}</Link>}
        title={
          <>
            Review <ObjId id={r.id} strong />
          </>
        }
        summary={
          <>
            For work item <ObjId id={r.subjectId} /> at revision {r.subjectRevision}.
          </>
        }
      />
      <ReviewCard review={r} nameOf={nameOf} />
      <section className="stack">
        <h2 className="section-title">Pinned evidence</h2>
        {r.artifactIds.length === 0 && <div className="empty">No artifacts pinned.</div>}
        {r.artifactIds.map((artifactId) => (
          <ArtifactBody key={artifactId} artifactId={artifactId} />
        ))}
      </section>
    </div>
  );
}

export function ReviewsView(props: ViewProps) {
  return (
    <Routes>
      <Route index element={<ReviewList {...props} />} />
      <Route path=":id" element={<ReviewDetail {...props} />} />
    </Routes>
  );
}
