/**
 * The board as an app of its own: no rail, no pages, no project. A person lands on a board, and its
 * title is the way to any other. Pi is a line at the foot of the canvas, with one conversation per
 * board. A person has one project, made and chosen as they first sign in and never named to them.
 */
import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import type { BoardSummary } from '@merv/board/models';
import { accountRequest, call, refreshTools, safely, useTool, type Project } from '../api';
import { ErrorBoundary, PageLoad } from '../components';
import { SessionProvider } from '../session';
import { useRoomy } from '../theme';
import { BoardStage } from '../views/board';
import { PiProvider } from '../views/pi';
import { BoardHead } from './head';
import { drawSample } from './sample';
import { BoardBar, Conversation } from './talk';
import type { ComponentProps } from 'react';

/** The board this browser last had open. */
const LAST = 'board:last';
/** A person's first project is made once, whichever tab or retry asks. */
const FIRST_PROJECT = 'board-app-first';

/** A new board, or the empty one already waiting: empty boards do not pile up in the list. */
export async function newBoard() {
  const { boards } = await call<{ boards: BoardSummary[] }>('board.read', {});
  const empty = boards.find(({ title, revision }) => title === 'Untitled' && !revision);
  if (empty) return empty.id;
  const made = await call<{ board: BoardSummary }>('board.write:draw', { title: 'Untitled' });
  refreshTools('board.read');
  return made.board.id;
}

/** Where a sign-in goes with no project chosen: their one project, made if there is none. */
function OneProject({
  account,
  choose,
}: ComponentProps<NonNullable<ComponentProps<typeof SessionProvider>['Chooser']>>) {
  useEffect(() => {
    const [first] = account.projects;
    if (first) return choose(first.id);
    void accountRequest<{ project: Project }>('/projects', {
      method: 'POST',
      body: { name: 'Boards', requestId: FIRST_PROJECT },
    }).then(({ project }) => choose(project.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <main className="signin empty" />;
}

/** A person never lands on a list: the board they last had open, the newest, or a new one. */
function Landing() {
  const navigate = useNavigate();
  const boards = useTool<{ boards: BoardSummary[] }>('board.read', {});
  const list = boards.data?.boards;
  useEffect(() => {
    if (!list) return;
    const last = safely(() => localStorage.getItem(LAST), null);
    const known = list.find((board) => board.id === last) ?? list[0];
    // Someone's first visit opens on the sample, playing: this is what it does, before any words.
    void (
      known ? Promise.resolve(`${known.id}`) : drawSample().then((id) => `${id}?play`, newBoard)
    ).then((to) => navigate(`/boards/${to}`, { replace: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!list]);
  return boards.error ? <PageLoad {...boards} /> : null;
}

function Board() {
  const { id = '' } = useParams();
  const [talking, setTalking] = useState(false);
  const roomy = useRoomy();
  useEffect(() => void safely(() => localStorage.setItem(LAST, id)), [id]);
  return (
    <BoardStage
      id={id}
      title={(board) => board.title}
      beside={(outcomes) =>
        talking && roomy && !outcomes.shown && <Conversation close={() => setTalking(false)} />
      }
      head={(board, outcomes) => (
        <BoardHead
          board={board}
          outcomes={outcomes}
          talk={() => setTalking(!talking)}
          talking={talking}
        />
      )}
    >
      {(board) => (
        <>
          <BoardBar board={board} open={() => setTalking(true)} />
          {talking && !roomy && <Conversation close={() => setTalking(false)} />}
        </>
      )}
    </BoardStage>
  );
}

export function BoardApp() {
  return (
    <SessionProvider Chooser={OneProject}>
      <PiProvider>
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/boards/:id" element={<Board />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ErrorBoundary>
      </PiProvider>
    </SessionProvider>
  );
}
