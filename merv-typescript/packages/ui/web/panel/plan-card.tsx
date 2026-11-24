import { useState } from 'react';
import { Prose } from './prose';

/** A plan stays small until the person wants to read it through. */
export function PlanCard({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  return (
    <>
      <div className={`approval-plan ${all ? 'is-open' : ''}`}>
        <Prose text={text || 'No plan was supplied.'} />
      </div>
      {!!text && (
        <button className="quiet plan-read" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Less' : 'Read all'}
        </button>
      )}
    </>
  );
}
