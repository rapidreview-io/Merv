/**
 * An agent's question, answered where Needs you names it: merv-desktop's question card, with the
 * worded answers the agent offered (`session.ask_owner` options) as its buttons. The choice goes to
 * the asking agent's thread as the person's answer, as one typed in its box would. A question that
 * offered no answers is answered in its thread's box, where the line leads.
 */
import { useState } from 'react';
import type { ProjectThreads } from '@merv/sessions/models';
import { useTool } from '../api';
import { QuestionCard } from '../panel/question-card';
import { answerThread } from './thread-data';

export function AgentQuestion({ thread }: { thread: string }) {
  // The same read the panel and the Agents page share.
  const read = useTool<ProjectThreads>('/sessions/threads', {}, { every: 8000 });
  const asked = read.data?.threads.find((one) => one.id === thread)?.question;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  if (!asked?.options?.length) return null;
  return (
    <div className="web-panel is-inline needs-question">
      <div className="approval">
        <QuestionCard
          questions={[
            {
              id: asked.id,
              question: asked.question,
              options: asked.options.map((label) => ({ label })),
              isSecret: false,
            },
          ]}
          busy={busy}
          decide={async (decision) => {
            // Skipping sends nothing: the question stands until it is answered.
            if (decision.kind !== 'answer') return false;
            const text = (decision.answers?.[asked.id] ?? []).join(', ') || decision.text || '';
            if (!text) return false;
            setBusy(true);
            setProblem('');
            try {
              return await answerThread(thread, asked.id, text);
            } catch (error) {
              setProblem((error as Error).message);
              return false;
            } finally {
              setBusy(false);
            }
          }}
        />
        {problem && (
          <p className="count" role="alert">
            That answer did not go: {problem}
          </p>
        )}
      </div>
    </div>
  );
}
