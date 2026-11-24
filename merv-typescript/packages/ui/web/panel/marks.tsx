import { providerName } from '@merv/protocol/runtime';
/**
 * The panel's shapes. Who is working is a shape, never a colour; colour is kept for state, so a
 * glance finds what needs a person. Every mark carries its name for whoever cannot see it.
 */
import { useEffect, useRef } from 'react';
import { orbPainter } from '@merv/protocol/orb';
import type { Provider } from '@merv/protocol/runtime';

/** Claude Code and Codex by their own marks: Claude's spark in its orange, OpenAI's knot for Codex. */
const CLAUDE =
  'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z';
const OPENAI =
  'M22.282 9.821a5.985 5.985 0 0 0-.516-4.911 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .511 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.998-2.9 6.056 6.056 0 0 0-.748-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.041l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.169a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z';

export function ProviderMark({ provider, size = 20 }: { provider: Provider; size?: number }) {
  return (
    <svg
      className={`mark is-${provider}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={providerName(provider)}
    >
      <path
        d={provider === 'claude' ? CLAUDE : OPENAI}
        fill={provider === 'claude' ? '#D97757' : 'currentColor'}
      />
    </svg>
  );
}

/** A job's own mark: two linked rings, in no agent's shape and no agent's colour. A job's line wears it wherever it
 *  shows, running or ended, so a job is never read as a single agent. */
export function JobMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="mark job-mark"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <circle cx="5.5" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="10.5" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** How far a job has come, as a ring: empty before work, a pie filled for how far along, a check disc at done, a cross
 *  disc when stopped. Drawn in ink; the shape carries position and the sign carries the end, so it needs no hue. */
export { JobGlyph } from './column-row';

export type State = 'running' | 'waiting' | 'failed' | 'idle' | 'stopped' | 'past' | 'elsewhere';

const LABELS: Record<State, string> = {
  running: 'Working',
  waiting: 'Needs you',
  failed: 'Failed',
  idle: 'Done for now',
  stopped: 'Stopped',
  past: 'Earlier session',
  elsewhere: 'Running in another terminal',
};

/** One distinct shape per state, so unknown never reads as done. */
export function StateMark({ state }: { state: State }) {
  return (
    <svg
      className={`state-mark is-${state}`}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      role="img"
      aria-label={LABELS[state]}
    >
      <title>{LABELS[state]}</title>
      {state === 'running' && (
        <path
          className="spin"
          d="M7 1.5A5.5 5.5 0 1 1 1.5 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      )}
      {state === 'waiting' && <path d="M7 1.5 12.5 7 7 12.5 1.5 7Z" fill="currentColor" />}
      {state === 'failed' && (
        <>
          <circle cx="7" cy="7" r="5.6" fill="currentColor" />
          <path
            d="M7 4v3.6M7 9.8v.1"
            stroke="var(--panel)"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </>
      )}
      {/* At rest, whether here or in the past, a session needs no mark: only what asks for attention has one. */}
      {state === 'elsewhere' && (
        <path
          d="M5 2.5h6.5V9M11.5 2.5 3 11"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

export type ToolKind = 'read' | 'search' | 'edit' | 'run' | 'web' | 'think' | 'tool';

/** What a tool call is, from whatever the agent named it. */
export function toolKind(kind: string, title: string): ToolKind {
  // A shell command is a command, whatever it greps or finds.
  if (/^(bash|command|commandexecution|exec|shell)\b/i.test(kind) || /^bash\b/i.test(title))
    return 'run';
  const k = `${kind} ${title}`.toLowerCase();
  if (/websearch|webfetch|web_search|search: |fetch /.test(k)) return 'web';
  if (/^(read|notebookread)|\bread\b/.test(k) && !/thread/.test(k)) return 'read';
  if (/grep|glob|search|find/.test(k)) return 'search';
  if (/edit|write|filechange|patch|file change/.test(k)) return 'edit';
  if (/bash|command|exec|run |zsh|shell/.test(k)) return 'run';
  if (/reason|think/.test(k)) return 'think';
  return 'tool';
}

const GLYPHS: Record<ToolKind, string> = {
  read: 'M4 3h6l3 3v8H4zM10 3v3h3',
  search: 'M7.5 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM11 11l3.5 3.5',
  edit: 'M3 13.5V16h2.5L14 7.5 11.5 5zM10.5 6l2.5 2.5',
  run: 'M3.5 5 7 8.5 3.5 12M8.5 13h5',
  web: 'M8.5 15a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM2 8.5h13M8.5 2c2 2 2 11 0 13M8.5 2c-2 2-2 11 0 13',
  think: 'M6 13h5M6.5 15.5h4M8.5 2a4.5 4.5 0 0 0-2.6 8.2V12h5.2v-1.8A4.5 4.5 0 0 0 8.5 2Z',
  tool: 'M10 3a3 3 0 0 0-2.8 4L3 11.2 5.8 14 10 9.8A3 3 0 1 0 10 3Z',
};

export function ToolGlyph({ kind }: { kind: ToolKind }) {
  return (
    <svg width="16" height="16" viewBox="0 0 17 17" aria-hidden="true">
      <path
        d={GLYPHS[kind]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LinkMark({ on }: { on: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M7.5 10.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2L9 4.8M10.5 7.5a3 3 0 0 0-4.2 0L3.7 10.1a3 3 0 0 0 4.2 4.2L9 13.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {!on && <path d="M3 3l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
    </svg>
  );
}

/** Merv's mark: the board's orb, small, drawn once with the same faceted sphere. */
export function MervMark({ working }: { working?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current!;
    orbPainter(el)(
      { kind: 'off', hearing: true, muted: false, voice: 'merv' },
      el.clientWidth || 18,
      false,
      0,
      true,
    );
  }, []);
  return (
    <span className={`merv-mark ${working ? 'is-working' : ''}`} role="img" aria-label="Merv">
      <canvas ref={canvas} />
    </span>
  );
}
