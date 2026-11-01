/**
 * Experiment: a board's tasks and the person's own agents (packages/board/src/agents.ts). A pill
 * says whether their machine is on; the pane lists each task with its checks and hands it off, the
 * way a phone does it, since a phone cannot point at a frame. On a wide screen, selecting a task on
 * the board offers the same hand-off above it. Nothing here runs without that plugin: the state
 * read fails and the page stays as it was.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { getCommonBounds } from '@excalidraw/excalidraw';
import type { AgentHarness, AgentRun, AgentsState } from '@merv/board/agents-models';
import { call, refreshTools, useTool } from '../api';
import { useNow } from '../components';
import { useSay } from './pi';

const NAMES: Record<AgentHarness, string> = { claude: 'Claude Code', codex: 'Codex' };
const OVER = new Set<AgentRun['state']>(['passed', 'failed', 'stopped', 'error']);
export const DISTIL = 'Distil this board into tasks with measurable checks.';

const agoOf = (at: string, now: number) => {
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (seconds < 90) return `${seconds} s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
};

/** Hands off, and shows why it could not. */
function useHand() {
  const [problem, setProblem] = useState('');
  const act = (tool: string, input: Record<string, unknown>) =>
    void call(tool, input).then(
      () => (setProblem(''), refreshTools('board.agents.state')),
      (error: Error) => setProblem(error.message),
    );
  return { problem, act };
}

function TaskRow({
  task,
  connector,
  focus,
}: {
  task: AgentsState['tasks'][number];
  connector: AgentsState['connector'];
  focus(): void;
}) {
  const { problem, act } = useHand();
  const { latest: run } = task;
  const active = run && !OVER.has(run.state);
  const failed = run?.state === 'failed';
  const ways = (['claude', 'codex'] as const).filter(
    (way) => !connector?.online || connector.harnesses[way]?.ok,
  );
  return (
    <li className="board-agents-task" data-state={run?.state ?? 'ready'}>
      <button type="button" className="board-agents-title" onClick={focus}>
        {task.title}
      </button>
      {task.said && <p className="board-agents-said">{task.said}</p>}
      {task.changed && <p className="board-agents-changed">Changed since handed off</p>}
      <ul className="board-agents-checks">
        {task.checks.map((held) => (
          <li
            key={held.id}
            data-pass={
              !held.verdict
                ? undefined
                : !held.verdict.pass
                  ? 'false'
                  : held.verdict.how === 'command'
                    ? 'true'
                    : 'eyes'
            }
          >
            {held.text}
            {held.verdict && <small>{held.verdict.reason}</small>}
          </li>
        ))}
      </ul>
      <div className="board-agents-ways">
        {active ? (
          <button
            type="button"
            className="btn-text"
            onClick={() => act('board.agents.stop', { run: run.id })}
          >
            Stop
          </button>
        ) : (
          <>
            {failed && (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  act('board.agents.handoff', {
                    task: task.id,
                    harness: run.harness,
                    sendBack: true,
                  })
                }
              >
                Send back to {NAMES[run.harness]}
              </button>
            )}
            {ways.map((way) => (
              <button
                type="button"
                key={way}
                className={failed ? 'btn-text' : 'btn'}
                onClick={() => act('board.agents.handoff', { task: task.id, harness: way })}
              >
                {NAMES[way]}
              </button>
            ))}
          </>
        )}
      </div>
      {problem && <p className="board-agents-problem">{problem}</p>}
    </li>
  );
}

/** Frames and everything in them, which the selection's own asks leave to the hand-off above it. */
export function useTaskFrames(id: string) {
  // On a server without the plugin the first read fails and there is no second.
  const read = useTool<AgentsState>(
    'board.agents.state',
    { board: id },
    { every: (data) => (data ? 2500 : undefined) },
  );
  const frames = useMemo(
    () => new Set((read.data?.tasks ?? []).map((task) => task.frame)),
    [read.data?.tasks],
  );
  return { state: read.data, frames };
}

export function BoardAgents({ id, api }: { id: string; api: ExcalidrawImperativeAPI }) {
  const { state, frames } = useTaskFrames(id);
  // The recorded walkthrough (scripts/demo-command-center-walk.mjs) finds shapes on the screen by it.
  useEffect(() => void ((window as { boardApi?: unknown }).boardApi = api), [api]);
  const [open, setOpen] = useState(false);
  const said = useSay(true);
  const now = useNow(5000);
  const { problem, act } = useHand();
  const [chosen, setChosen] = useState<{ task: string; left: number; top: number } | null>(null);
  useEffect(
    () =>
      api.onChange((elements, app) => {
        const picked = elements.filter((el) => app.selectedElementIds[el.id] && !el.isDeleted);
        const frame = picked.map((el) => (frames.has(el.id) ? el.id : el.frameId)).find(Boolean);
        if (!frame || !frames.has(frame) || app.editingTextElement)
          return setChosen((held) => (held ? null : held));
        const whole = elements.find((el) => el.id === frame)!;
        const [x1, y1, x2] = getCommonBounds([whole]);
        const left = Math.round(((x1 + x2) / 2 + app.scrollX) * app.zoom.value);
        const top = Math.max(44, Math.round((y1 + app.scrollY) * app.zoom.value - 24));
        const task = state?.tasks.find((held) => held.frame === frame)?.id;
        if (task)
          setChosen((held) =>
            held?.task === task && held.left === left && held.top === top
              ? held
              : { task, left, top },
          );
      }),
    [api, frames, state?.tasks],
  );
  if (!state) return null;
  const { connector, tasks, waiting } = state;
  const machine = connector?.name ?? 'No machine';
  const standing = connector?.online
    ? 'online'
    : connector
      ? `offline, ${agoOf(connector.seen, now)}`
      : 'connected';
  const chosenTask = chosen && tasks.find((task) => task.id === chosen.task);
  const busy = chosenTask?.latest && !OVER.has(chosenTask.latest.state);
  const focus = (frame: string) => {
    const whole = api.getSceneElements().find((el) => el.id === frame);
    if (whole)
      api.scrollToContent(whole, { fitToViewport: true, viewportZoomFactor: 0.7, animate: true });
    if (!matchMedia('(min-width: 731px)').matches) setOpen(false);
  };
  return (
    <>
      <button
        type="button"
        className="board-agents-pill"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="board-agents-dot" data-online={connector?.online ? '' : undefined} />
        {machine} {standing}
        {waiting > 0 && <strong> · {waiting} waiting</strong>}
        {tasks.length > 0 && ` · ${tasks.length} task${tasks.length === 1 ? '' : 's'}`}
      </button>
      {open && (
        <aside className="board-agents-pane" aria-label="Tasks">
          {said && (
            <button type="button" className="btn-text" onClick={() => void said.say(DISTIL)}>
              Make tasks from this board
            </button>
          )}
          <ul>
            {tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                connector={connector}
                focus={() => focus(task.frame)}
              />
            ))}
          </ul>
        </aside>
      )}
      {chosenTask && !busy && (
        <div
          className="board-selection"
          style={{ left: chosen!.left, top: chosen!.top }}
          aria-label={`Hand off ${chosenTask.title}`}
        >
          {(['claude', 'codex'] as const).map((way) => (
            <button
              type="button"
              key={way}
              onClick={() => act('board.agents.handoff', { task: chosenTask.id, harness: way })}
            >
              Hand to {NAMES[way]}
            </button>
          ))}
          {problem && <span className="board-selection-note">{problem}</span>}
        </div>
      )}
      {chosenTask && busy && (
        <div className="board-selection" style={{ left: chosen!.left, top: chosen!.top }}>
          <button
            type="button"
            onClick={() => act('board.agents.stop', { run: chosenTask.latest!.id })}
          >
            Stop
          </button>
        </div>
      )}
    </>
  );
}
