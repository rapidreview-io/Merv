/** The board's one menu, at Excalidraw's own button: where the person is, the way to any other board, and the rest. */
import { useState } from 'react';
import { MainMenu } from '@excalidraw/excalidraw';
import { useNavigate } from 'react-router-dom';
import type { BoardSummary } from '@merv/board/models';
import { call, refreshTools, useTool } from '../api';
import { useSession } from '../session';
import { BoardTitle } from '../views/board';
import type { useOutcomes } from '../views/board-outcome';
import { useAgent } from '../views/pi';
import { newBoard } from './app';

/** How many other boards the menu names; the newest come first. */
const BOARDS = 6;
/** What keeps the menu open after a choice that has more to say. */
const stay = (event: Event) => event.preventDefault();

export function BoardMenu({
  board,
  outcomes,
}: {
  board: BoardSummary;
  outcomes: ReturnType<typeof useOutcomes>;
}) {
  const navigate = useNavigate();
  const { signOut, account } = useSession();
  const pi = useAgent()?.pi;
  const models = pi?.snapshot?.models;
  const chosen = pi?.snapshot?.conversation.model;
  const others = (useTool<{ boards: BoardSummary[] }>('board.read', {}).data?.boards ?? [])
    .filter(({ id }) => id !== board.id)
    .slice(0, BOARDS);
  const [editing, setEditing] = useState(false);
  const [sure, setSure] = useState(false);
  const [link, setLink] = useState('');
  const archive = async () => {
    await call('board.set', { id: board.id, archived: true });
    refreshTools('board.read');
    navigate('/');
  };
  const share = async (revoke: boolean) => {
    const result = await call<{ token?: string }>('board.share', { id: board.id, revoke });
    const url = result.token ? `${location.origin}/ui/board-share#${result.token}` : '';
    setLink(url);
    if (url) await navigator.clipboard?.writeText(url).catch(() => undefined);
  };
  return (
    <>
      <MainMenu.ItemCustom>
        {editing ? (
          <BoardTitle board={board} editing done={() => setEditing(false)} />
        ) : (
          <button type="button" className="board-menu-title" onClick={() => setEditing(true)}>
            {board.title}
          </button>
        )}
      </MainMenu.ItemCustom>
      <MainMenu.Separator />
      <MainMenu.Item onSelect={() => void newBoard().then((id) => navigate(`/boards/${id}`))}>
        New board
      </MainMenu.Item>
      {others.map(({ id, title }) => (
        <MainMenu.Item key={id} onSelect={() => navigate(`/boards/${id}`)}>
          {title}
        </MainMenu.Item>
      ))}
      <MainMenu.Separator />
      <MainMenu.Item onSelect={() => void outcomes.toggle().catch(() => undefined)}>
        Outcome
      </MainMenu.Item>
      <MainMenu.Item
        onSelect={(event) => {
          stay(event);
          void share(!!link).catch(() => undefined);
        }}
      >
        {link ? 'Link copied. Revoke it' : 'Copy watch link'}
      </MainMenu.Item>
      {!!models && models.length > 1 && (
        <MainMenu.Item
          onSelect={(event) => {
            stay(event);
            const next = models[(models.findIndex(({ id }) => id === chosen) + 1) % models.length]!;
            void pi!.pickModel(next.id);
          }}
        >
          Model · {models.find(({ id }) => id === chosen)?.label}
        </MainMenu.Item>
      )}
      <MainMenu.Separator />
      <MainMenu.Item
        onSelect={(event) => {
          if (sure) return void archive().catch(() => undefined);
          stay(event);
          setSure(true);
        }}
      >
        {sure ? 'Archive: press again' : 'Archive this board'}
      </MainMenu.Item>
      {account.kind === 'user' && <MainMenu.Item onSelect={signOut}>Sign out</MainMenu.Item>}
    </>
  );
}
