import { type Request, type Thread, sessionTitle, folderName } from './rows';
import { useState, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import { type Question, type Decision } from '@merv/protocol/runtime';
import { didWhat, unshell } from './tool-words';
import { useDeskCall } from './desk-calls';
import { secretQuestion } from '@merv/protocol/runtime';
import { approvalPreview, diffLines } from './diff';
import { ProviderMark } from './marks';
import { QuestionCard } from './question-card';
import { PlanCard } from './plan-card';

/** What a request asks, said once for a reader: `said`, a plain sentence (the agent's own description of the action when
 *  it gave one, else one made from the kind of action), and `exact`, the command or input itself when the sentence does
 *  not already hold it. Nothing for a request whose own title is already its sentence (a folder, more access, a question). */
export function requestWords(
  request: Pick<Request, 'kind' | 'title' | 'detail'>,
  cwd?: string,
): { said: string; exact?: string; command?: boolean } | undefined {
  let input: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(request.detail ?? 'null');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
  } catch {
    /* Codex details are plain text. */
  }
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const one = (value: string) => value.replace(/\s+/g, ' ').trim();
  // A path under the agent's own folder is said from there; any other is said whole.
  const path = (value: string) =>
    cwd && value.startsWith(`${cwd.replace(/\/$/, '')}/`)
      ? value.slice(cwd.replace(/\/$/, '').length + 1)
      : value;
  const described = text(input?.description);
  if (request.kind === 'command' && input?.setup === true) return;
  if (
    request.kind === 'command' ||
    (request.kind === 'tool' && /^(Run |Bash\b)/.test(request.title))
  ) {
    // Codex gives its reason as the first lines of the detail, before "in <folder>".
    const reason = input
      ? undefined
      : text(
          (request.detail ?? '')
            .split('\n')
            .filter((line) => !/^in \//.test(line))
            .join(' '),
        );
    return {
      said: one(described ?? reason ?? 'Run a shell command'),
      exact: text(input?.command) ?? request.title.replace(/^(Run |Bash\s*)/, ''),
      command: true,
    };
  }
  if (request.kind === 'file_change') {
    const named = /^Change (\S.*)$/.exec(request.title)?.[1] ?? 'files';
    return { said: `Edit ${/^(\d+|some) files$/.test(named) ? named : path(named)}` };
  }
  if (request.kind !== 'tool') return;
  const tool = /^(Edit|Write|MultiEdit|NotebookEdit|Read|Fetch)(?: (.*))?$/s.exec(request.title);
  if (tool)
    return {
      said: `${tool[1] === 'Fetch' ? 'Fetch' : tool[1] === 'Read' ? 'Read' : tool[1] === 'Write' ? 'Write' : 'Edit'} ${tool[1] === 'Fetch' ? (tool[2] ?? 'a web page') : path(tool[2] ?? 'a file')}`,
    };
  // Any other tool: its own description when it has one, else its name; what it is given is read below, once.
  const name = request.title.replace(/^mcp__(.+?)__(.+)$/, '$1: $2').replace(/_/g, ' ');
  const given =
    input && Object.keys(input).filter((key) => key !== 'description').length
      ? JSON.stringify(
          Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'description')),
          null,
          2,
        )
      : undefined;
  return { said: one(described ?? `Use the tool ${name}`), ...(given && { exact: given }) };
}

/** A command cut where a reader would cut it: before each `&&`, `||`, `;` and `|` outside quotes. Joined, the pieces are
 *  the command to the letter; each is kept whole on a line where it fits, so a long line breaks between steps. */
export function commandSteps(command: string): string[] {
  const steps: string[] = [];
  let from = 0,
    quote = '';
  for (let at = 0; at < command.length; at++) {
    const char = command[at]!;
    if (char === '\\') {
      at++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if ((char === ';' || char === '|' || (char === '&' && command[at + 1] === '&')) && at > from) {
      steps.push(command.slice(from, at));
      from = at;
      if (command[at + 1] === char) at++;
    }
  }
  steps.push(command.slice(from));
  return steps.filter(Boolean);
}

/** The exact command or input, once: wrapped, six lines of it, and the rest behind a word. */
function Exact({ text, command }: { text: string; command?: boolean }) {
  const [all, setAll] = useState(false);
  const [over, setOver] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = pre.current;
      if (el && !all) setOver(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined' || !pre.current) return;
    const watch = new ResizeObserver(measure);
    watch.observe(pre.current);
    return () => watch.disconnect();
  }, [text, all]);
  return (
    <div className="approval-exact">
      <pre
        ref={pre}
        className={`approval-preview is-wrapped${all ? ' is-all' : ''}`}
        tabIndex={all ? 0 : undefined}
      >
        {command && (
          <span className="approval-prompt" aria-hidden="true">
            ${' '}
          </span>
        )}
        {command
          ? commandSteps(text).map((step, index) => (
              <span key={index} className="approval-step">
                {step}
              </span>
            ))
          : text}
      </pre>
      {(over || all) && (
        <button
          className="quiet-word approval-all"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all ? 'show less' : 'show all'}
        </button>
      )}
    </div>
  );
}

/** One place for what needs the person: the exact action, and words on the buttons. */
/** `send` carries a decision when the card is far from the desk (the web); `remote` then leaves out what
 *  only the Mac may grant: a whole session, a whole folder, a plan sent to the board. */
export function Approval({
  requests,
  threads,
  open,
  onOpen,
  onDone,
  onError,
  compact = false,
  send,
  remote = false,
  plain = false,
  listed = false,
}: {
  /** In a project's main thread: no card. Who asks and "needs you" in words, the action, Allow as the one button, the rest as words. */
  plain?: boolean;
  /** With `plain`, under the list of projects: no head above says whose agent asks, so its project is said after its name. */
  listed?: boolean;
  compact?: boolean;
  requests: Request[];
  threads: (Pick<Thread, 'id' | 'provider' | 'title' | 'cwd'> &
    Pick<Partial<Thread>, 'worktree'>)[];
  open?: string;
  onOpen(id: string): void;
  onDone(): void;
  onError(message: string): void;
  send?(request: Request, decision: Decision, secret: boolean): Promise<void>;
  remote?: boolean;
}) {
  const call = useDeskCall();
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const request = requests[0]!;
  const thread = threads.find((t) => t.id === request.thread);
  const options: string[] = request.options ? JSON.parse(request.options) : [];
  const question = request.kind === 'question' || request.kind === 'elicitation';
  const plan = request.kind === 'plan';
  const questions: Question[] = request.questions
    ? JSON.parse(request.questions)
    : [{ id: '0', question: request.title, options: options.map((label) => ({ label })) }];
  const folder = request.kind === 'folder';
  // A file edit can be let go ahead for the whole folder, so the next ones do not ask.
  const editing =
    request.kind === 'tool' && /^(Edit|Write|MultiEdit|NotebookEdit) /.test(request.title);
  // Paths read as the file's name; a shell line as what it does.
  const asked =
    request.kind === 'command'
      ? didWhat(unshell(request.title))
      : request.title.replace(/(?:\/[\w.@-]+)+\/([\w.@-]+)/g, '$1');
  // Without a card the request is said once, in words, and the exact thing is shown once under them.
  const words = useMemo(
    () => (plain ? requestWords(request, thread?.cwd) : undefined),
    [plain, request.kind, request.title, request.detail, thread?.cwd],
  );
  const forSession = () =>
    answer(
      plain ? 'Always allow this for this agent' : 'Allow for this session',
      { kind: 'allow', forSession: true },
      plain ? { className: 'quiet' } : {},
    );
  const forFolder = () =>
    answer('Allow edits in this folder', async () => {
      await call('edits', { thread: request.thread, yes: true }).catch(() => undefined);
      await decide({ kind: 'allow' });
    });
  const decide = async (decision: Decision) => {
    if (question && !request.questions && decision.kind === 'answer')
      decision = { kind: 'answer', text: decision.answers?.['0']?.join(', ') };
    setBusy(true);
    const secret = question && questions.some(secretQuestion) && decision.kind === 'answer';
    let sent = true;
    await (
      send
        ? send(request, decision, secret)
        : call(`requests/${request.id}${secret ? '/secret' : ''}`, { decision })
    ).catch((e) => {
      sent = false;
      onError(
        (e as Error).message === 'delivery_failed'
          ? "That answer didn't reach the agent; it stopped waiting."
          : (e as Error).message,
      );
    });
    setMore(false);
    setBusy(false);
    onDone();
    const back = replyBox.current,
      held = card.current;
    if (back)
      requestAnimationFrame(() => {
        const focused = document.activeElement;
        if (back.isConnected && (!focused || focused === document.body || held?.contains(focused)))
          back.focus({ preventScroll: true });
      });
    return sent;
  };
  const answer = (
    text: string,
    decision: Decision | (() => Promise<void>),
    props: React.ButtonHTMLAttributes<HTMLButtonElement> = {},
  ) => (
    <button
      disabled={busy}
      onClick={() => (typeof decision === 'function' ? decision() : decide(decision))}
      {...props}
    >
      {text}
    </button>
  );
  // Show the action before asking; unfamiliar tools keep their detail toggle.
  const preview = useMemo(
    () => approvalPreview(request),
    [request.kind, request.title, request.detail],
  );
  const lines = useMemo(() => (preview?.kind === 'diff' ? diffLines(preview.text) : []), [preview]);
  const [details, setDetails] = useState(false);
  // Enter answers a request only once it has been in sight a moment, and only when nothing else has focus:
  // a keystroke already on its way, or meant for another control, never answers it.
  // The open chat's own reply box, with nothing typed in it, gives way too: the person's hands are already
  // there to answer, and the box has them back once they have.
  const card = useRef<HTMLDivElement>(null);
  const replyBox = useRef<HTMLElement>();
  useEffect(() => {
    const timer = setTimeout(() => {
      const focused = document.activeElement as HTMLElement | null;
      const idleReply =
        request.thread === open &&
        focused instanceof HTMLTextAreaElement &&
        !focused.value &&
        !!focused.closest('.composer') &&
        !!card.current &&
        !!focused.closest('.thread')?.contains(card.current);
      if (focused && focused !== document.body && !idleReply) return;
      const answer = card.current?.querySelector<HTMLElement>(
        '.question-options button, .question-answer input, .primary',
      );
      if (!answer) return;
      if (idleReply) replyBox.current = focused!;
      answer.focus({ preventScroll: true });
    }, 700);
    return () => clearTimeout(timer);
  }, [request.id]);
  return (
    <div
      className={`approval${plain ? ' is-plain' : ''}`}
      ref={card}
      role={plain ? 'group' : undefined}
      aria-label={plain ? 'Needs you' : undefined}
    >
      {/* Who asks goes unsaid when it is the chat already open above. Without a card, the words "needs you" are what marks it. */}
      {(plain || request.thread !== open || requests.length > 1) && (
        <div className="approval-who">
          {(request.thread !== open || requests.length > 1) && (
            <>
              {thread && <ProviderMark provider={thread.provider} size={plain ? 16 : 14} />}
              <button className="approval-thread" onClick={() => !folder && onOpen(request.thread)}>
                {folder ? 'Merv' : thread ? sessionTitle(thread.title, thread.cwd) : 'A session'}
              </button>
            </>
          )}
          {plain && listed && thread && !folder && (
            <span className="approval-where">
              in {folderName(thread.worktree?.folder ?? thread.cwd)}
            </span>
          )}
          {plain && (
            <span className="approval-needs">
              {request.thread !== open || requests.length > 1 ? 'needs you' : 'Needs you'}
            </span>
          )}
          {requests.length > 1 && (
            <span className="count">
              {plain ? `${requests.length} waiting` : `1/${requests.length}`}
            </span>
          )}
        </div>
      )}
      {words && !question && !plan ? (
        <>
          <p className="approval-ask" title={words.said}>
            {words.said}
          </p>
          {words.exact ? (
            <Exact key={request.id} text={words.exact} command={words.command} />
          ) : (
            preview?.kind === 'diff' && (
              <pre className="approval-preview diff">
                {lines.map((line, i) => (
                  <span key={i} className={line.kind}>
                    {line.parts.map((part, p) =>
                      part.changed ? <mark key={p}>{part.text}</mark> : part.text,
                    )}
                    {'\n'}
                  </span>
                ))}
              </pre>
            )
          )}
        </>
      ) : compact && preview?.kind !== 'setup' && !question && !plan ? (
        <p className="approval-ask">
          {request.kind === 'command' ? 'Run a script' : editing ? 'Edit files' : 'Use a tool'}
          {thread ? ` in ${folderName(thread.cwd)}` : ''}
        </p>
      ) : (
        !question &&
        !plan && (
          <>
            {/* Paths read as the file's name; the whole of it is a hover away. */}
            {/* Beside the command itself, what it would do is said as a wish: nothing has run yet. */}
            {preview ? (
              <div className="approval-ask">{asked}</div>
            ) : (
              <button
                className="approval-ask"
                onClick={() => request.detail && setDetails(!details)}
              >
                {asked}
              </button>
            )}
            {preview?.kind === 'setup' && <p>{preview.detail}</p>}
            {preview ? (
              <pre className={`approval-preview ${preview.kind === 'diff' ? 'diff' : ''}`}>
                {preview.kind === 'diff'
                  ? lines.map((line, i) => (
                      <span key={i} className={line.kind}>
                        {line.parts.map((part, p) =>
                          part.changed ? <mark key={p}>{part.text}</mark> : part.text,
                        )}
                        {'\n'}
                      </span>
                    ))
                  : preview.text}
              </pre>
            ) : (
              details && request.detail && <pre className="approval-detail">{request.detail}</pre>
            )}
          </>
        )
      )}
      {question && remote && questions.some(secretQuestion) ? (
        <>
          {/* A secret goes to the agent as a file on the Mac, never across the network: it is asked for there. */}
          <span className="approval-ask">{questions.find(secretQuestion)!.question}</span>
          <span className="count">Answer this one on your Mac: a secret is only taken there.</span>
        </>
      ) : question ? (
        <QuestionCard key={request.id} questions={questions} busy={busy} decide={decide} />
      ) : plan ? (
        <>
          <PlanCard text={request.detail ?? ''} />
          <div className="actions">
            {answer('Go ahead', { kind: 'allow' }, { className: 'primary' })}
            {answer(
              'Keep planning',
              { kind: 'deny', reason: 'Keep planning. Do not execute the plan yet.' },
              plain ? { className: 'quiet' } : {},
            )}
            {!remote &&
              answer(
                'To the board',
                { kind: 'board' },
                { disabled: busy || !request.detail?.trim(), ...(plain && { className: 'quiet' }) },
              )}
          </div>
        </>
      ) : (
        <div className="actions">
          {answer('Allow', { kind: 'allow' }, { className: 'primary' })}
          {/* The one choice that ends the asking for more of the same, said beside Allow and not behind a menu. */}
          {plain && !folder && !remote && preview?.kind !== 'setup' && forSession()}
          {answer(
            folder ? 'Not now' : plain ? 'Deny' : '×',
            { kind: 'deny' },
            {
              className: folder ? (plain ? 'quiet' : '') : 'quiet deny',
              title: folder ? 'Not now' : 'Deny',
              'aria-label': folder ? 'Not now' : 'Deny',
            },
          )}
          {!folder && !remote && preview?.kind !== 'setup' && (!plain || editing) && (
            <span className="plus">
              <button
                className="quiet"
                aria-label="More choices"
                aria-expanded={more}
                onClick={() => setMore(!more)}
              >
                {plain ? 'More' : '⋯'}
              </button>
              {more && (
                <div className="menu up" onMouseLeave={() => setMore(false)}>
                  {!plain && forSession()}
                  {editing && forFolder()}
                </div>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
