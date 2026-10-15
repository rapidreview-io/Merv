import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { Markdown } from '../markdown';
import { customerRequest, said } from './api';
import { PlanCard } from './plan-card';

/** GET /plan: the one free-text document both sides edit, and where its verification stands. */
export interface Plan {
  revision: number;
  document: string;
  updatedBy: 'customer' | 'agent' | null;
  updatedAt: string | null;
  status: 'drafting' | 'verifying' | 'changes_requested' | 'accepted';
  feedback: string | null;
  contract: null | {
    version: number;
    priceCents: number;
    currency: string;
    limits?: Record<string, number>;
  };
}

const STATUS: Record<Plan['status'], string> = {
  drafting: 'Draft',
  verifying: 'Verifying',
  changes_requested: 'Changes requested',
  accepted: 'Accepted',
};
/** Workflow states after payment is confirmed: the experiment is paid for and under way. */
const PAID = ['queued', 'running', 'finalizing', 'results_review', 'complete', 'failed'];
const STATE: Record<string, string> = {
  queued: 'Paid · Queued',
  running: 'Paid · Running',
  finalizing: 'Paid · Preparing results',
  results_review: 'Paid · Checking results',
  complete: 'Complete',
  failed: 'Needs attention',
};
const SAVE_MS = 800;
const price = (contract: NonNullable<Plan['contract']>) =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: contract.currency || 'usd',
    minimumFractionDigits: contract.priceCents % 100 ? 2 : 0,
  }).format(contract.priceCents / 100);

/**
 * The plan as the customer edits it: the document, saved as it is typed against the revision it
 * was read at, while drafting or returned with changes; read-only while the agent verifies it and
 * once it is accepted. Submit sends it to the intake agent; an accepted plan is paid for here.
 */
export function PlanEditor({
  plan,
  state,
  agentBusy = false,
  reload,
}: {
  plan: Plan | null;
  /** The experiment's workflow state (GET /), which says whether it is paid. */
  state: string | null;
  /** The intake agent is in a turn: a submit waits for it, and a verifying plan is in hand. */
  agentBusy?: boolean;
  reload(): void;
}) {
  const [draft, setDraft] = useState(plan?.document ?? '');
  // The card is the plan's face; the text editor opens on Edit, or by itself for an empty plan.
  const [chosen, setPreview] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'saving' | 'submitting' | 'paying'>('');
  const [conflict, setConflict] = useState<Plan | null>(null);
  /** The revision and document this draft was last in step with on the server. */
  const synced = useRef<{ revision: number; document: string } | null>(
    plan ? { revision: plan.revision, document: plan.document } : null,
  );
  const saving = useRef<Promise<boolean> | null>(null);
  const preview = chosen ?? !!(plan?.document ?? '').trim();
  const editable = !!plan && (plan.status === 'drafting' || plan.status === 'changes_requested');
  const dirty = !!synced.current && draft !== synced.current.document;

  // A plan read anew is taken where nothing here is unsaved; over an unsaved edit it is a
  // conflict for the person to settle.
  useEffect(() => {
    if (!plan) return;
    const was = synced.current;
    if (!was || (plan.revision !== was.revision && draft === was.document)) {
      synced.current = { revision: plan.revision, document: plan.document };
      setDraft(plan.document);
    } else if (plan.revision !== was.revision && !saving.current) setConflict(plan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan?.revision]);

  const save = async (): Promise<boolean> => {
    // One save at a time: the next is sent against the revision the last one made.
    if (saving.current) await saving.current;
    const was = synced.current;
    if (!was || conflict) return false;
    if (draft === was.document) return true;
    const document = draft;
    const run = (async () => {
      setBusy('saving');
      try {
        const saved = await customerRequest<Partial<Plan>>('/plan', {
          method: 'PUT',
          body: { expectedRevision: was.revision, document },
        });
        synced.current = {
          revision: typeof saved.revision === 'number' ? saved.revision : was.revision + 1,
          document,
        };
        setError('');
        return true;
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 409) {
          const latest = await customerRequest<Plan>('/plan').catch(() => null);
          if (latest) setConflict(latest);
        } else setError(said(cause, 'Could not save the plan.'));
        return false;
      } finally {
        setBusy('');
        reload();
      }
    })();
    saving.current = run;
    try {
      return await run;
    } finally {
      if (saving.current === run) saving.current = null;
    }
  };
  // Saved a moment after typing stops.
  useEffect(() => {
    if (!editable || !dirty || conflict) return;
    const timer = setTimeout(() => void save(), SAVE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, editable, conflict]);

  const submit = async () => {
    if (busy || !plan) return;
    if (editable && !(await save())) return;
    setBusy('submitting');
    try {
      await customerRequest('/plan/submit', {
        method: 'POST',
        body: { expectedRevision: editable ? synced.current!.revision : plan.revision },
      });
      setError('');
    } catch (cause) {
      setError(said(cause, 'Could not submit the plan.'));
    } finally {
      setBusy('');
      reload();
    }
  };
  const pay = async () => {
    if (busy || !plan?.contract) return;
    setBusy('paying');
    try {
      const checkout = await customerRequest<{ url?: string; checkoutUrl?: string }>('/checkout', {
        method: 'POST',
        body: { contractVersion: plan.contract.version },
      });
      const url = new URL(checkout.url ?? checkout.checkoutUrl ?? '', location.origin);
      if (url.protocol !== 'https:') throw new Error('invalid');
      location.assign(url.href);
    } catch (cause) {
      setError(said(cause, 'Checkout is unavailable. Try again.'));
      setBusy('');
    }
  };

  if (!plan) return <p className="muted">Loading…</p>;
  const paid = !!state && PAID.includes(state);
  return (
    <section className="cx-plan" aria-label="Plan">
      <div className="cx-plan-bar">
        {editable && (
          <div className="cx-plan-actions">
            <button
              type="button"
              className="btn btn--quiet"
              aria-pressed={preview}
              onClick={() => setPreview(!preview)}
            >
              {preview ? 'Edit' : 'Preview'}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!!busy || !!conflict || !draft.trim() || agentBusy}
              onClick={() => void submit()}
            >
              {busy === 'submitting' ? 'Submitting…' : 'Submit'}
            </button>
          </div>
        )}
        {plan.status === 'verifying' && !agentBusy && (
          <div className="cx-plan-actions">
            <button type="button" className="btn" disabled={!!busy} onClick={() => void submit()}>
              {busy === 'submitting' ? 'Sending…' : 'Resend'}
            </button>
          </div>
        )}
      </div>
      {plan.feedback && plan.status !== 'accepted' && (
        <div className="cx-feedback" role="note">
          <Markdown source={plan.feedback} />
        </div>
      )}
      {conflict && (
        <div className="cx-conflict" role="alert">
          <span>The plan changed while you were editing.</span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              synced.current = { revision: conflict.revision, document: conflict.document };
              setDraft(conflict.document);
              setConflict(null);
            }}
          >
            Use latest
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              synced.current = { revision: conflict.revision, document: conflict.document };
              setConflict(null);
            }}
          >
            Keep mine
          </button>
        </div>
      )}
      {editable && !preview ? (
        <textarea
          className="textarea cx-plan-text"
          aria-label="Plan"
          value={draft}
          spellCheck
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void save()}
        />
      ) : (
        <PlanCard
          document={editable ? draft : plan.document}
          status={paid ? (STATE[state!] ?? STATUS.accepted) : STATUS[plan.status]}
          meta={[
            `revision ${plan.revision}`,
            plan.updatedAt &&
              new Date(plan.updatedAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              }),
          ]
            .filter(Boolean)
            .join(' · ')}
          {...(plan.contract?.limits ? { limits: plan.contract.limits } : {})}
        />
      )}
      {error && (
        <p className="pi-error" role="alert">
          {error}
        </p>
      )}
      {plan.status === 'accepted' && plan.contract && !paid && (
        <div className="cx-pay">
          <p>
            Your plan is accepted. Paying {price(plan.contract)} starts the experiment: Merv runs
            this plan within its accepted limits and emails the results to you. Payment is taken
            once, securely, by Stripe.
          </p>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!!busy}
            onClick={() => void pay()}
          >
            {busy === 'paying' ? 'Opening checkout…' : `Pay ${price(plan.contract)}`}
          </button>
        </div>
      )}
    </section>
  );
}
