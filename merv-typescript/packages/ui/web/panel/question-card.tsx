import { secretQuestion } from '@merv/protocol/runtime';
import { useState } from 'react';
import type { Decision, Question } from '@merv/protocol/runtime';

/** One question at a time keeps a whole interview in the approval slot. */
export function QuestionCard({
  questions,
  busy,
  decide,
}: {
  questions: Question[];
  busy: boolean;
  decide(decision: Decision): Promise<boolean | void>;
}) {
  const [index, setIndex] = useState(0);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [words, setWords] = useState<Record<string, string>>({});
  const question = questions[index];
  if (!question) return null;
  const secret = secretQuestion(question);
  const selected = picks[question.id] ?? [];
  const text = words[question.id] ?? '';
  const tooShort = secret && text.trim().length < 8;
  const answers = Object.fromEntries(
    questions.map((q) => [
      q.id,
      [
        ...(picks[q.id] ?? []),
        ...(words[q.id]?.trim() ? [secretQuestion(q) ? words[q.id] : words[q.id].trim()] : []),
      ],
    ]),
  );
  const next = () => {
    if (busy || tooShort || !answers[question.id].length) return;
    if (index < questions.length - 1) setIndex(index + 1);
    else if (Object.values(answers).every((values) => values.length)) {
      // What was typed stays until it has reached the agent: a failed send can be sent again.
      void decide({ kind: 'answer', answers }).then((sent) => {
        if (sent !== false) {
          setWords({});
          setPicks({});
        }
      });
    }
  };
  return (
    <>
      <div className="question-heading">
        <span className="approval-ask" title={question.question}>
          {question.question}
        </span>
        {questions.length > 1 && (
          <span className="count">
            {index + 1}/{questions.length}
          </span>
        )}
      </div>
      {!secret && (
        <div className="actions question-options" role="group" aria-label={question.question}>
          {question.options.map((option) => (
            <button
              key={option.label}
              disabled={busy}
              aria-pressed={selected.includes(option.label)}
              title={option.description}
              onClick={() => {
                setPicks({
                  ...picks,
                  [question.id]: question.multiSelect
                    ? selected.includes(option.label)
                      ? selected.filter((value) => value !== option.label)
                      : [...selected, option.label]
                    : [option.label],
                });
                if (!question.multiSelect) setWords({ ...words, [question.id]: '' });
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {secret && <span className="count">Saved privately for this session. Escape to cancel.</span>}
      <form
        className="actions question-answer"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            if (!busy)
              void decide({ kind: 'cancel' }).then((sent) => {
                if (sent !== false) {
                  setWords({});
                  setPicks({});
                }
              });
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          next();
        }}
      >
        <input
          aria-label={secret ? 'Private secret' : 'Free answer'}
          type={secret ? 'password' : 'text'}
          autoComplete="off"
          spellCheck={false}
          value={text}
          disabled={busy}
          placeholder="Answer…"
          onChange={(event) => {
            setWords({ ...words, [question.id]: event.target.value });
            if (!question.multiSelect) setPicks({ ...picks, [question.id]: [] });
          }}
        />
        {!secret && index > 0 && (
          <button type="button" disabled={busy} onClick={() => setIndex(index - 1)}>
            Back
          </button>
        )}
        <button
          type="submit"
          className="primary"
          disabled={busy || tooShort || !answers[question.id].length}
        >
          {index < questions.length - 1 ? 'Next' : 'Send'}
        </button>
        {!secret && (
          <button
            type="button"
            className="quiet"
            disabled={busy}
            onClick={() => void decide({ kind: 'cancel' })}
          >
            Skip
          </button>
        )}
      </form>
      {secret && (
        <span className="count">
          Merv hides it from saved history while the app is open. Ask the agent not to print it.
        </span>
      )}
      {tooShort && !!text && (
        <span className="count" role="status">
          Too short for a key
        </span>
      )}
    </>
  );
}
