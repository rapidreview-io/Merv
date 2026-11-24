/** Shared thumbnails belong to their mounted consumers; only unused pictures may be evicted. */
import { exportToBlob } from '@excalidraw/excalidraw';
import { boardAppearance } from '@merv/protocol/looks';
import type { BoardScene } from '@merv/board/models';
import { call } from '../api';

type Picture = {
  key: string;
  promise: Promise<string | undefined>;
  users: number;
  url?: string;
};
const pictures = new Map<string, Picture>();
/** Recently closed pictures stay reusable, independently of how many pictures are still visible. */
const unused = new Set<Picture>();
const UNUSED_PICTURES = 32;

function retire(picture: Picture) {
  unused.delete(picture);
  if (pictures.get(picture.key) === picture) pictures.delete(picture.key);
  if (picture.url) {
    URL.revokeObjectURL(picture.url);
    picture.url = undefined;
  }
}

/** Each caller releases its lease when unmounted or when its board/theme/revision changes. */
export function boardPicture(board: string, dark: boolean, revision?: number) {
  const key = `${board}:${dark}:${revision ?? ''}`;
  let picture = pictures.get(key);
  if (!picture) {
    const promise = call<BoardScene>('board.scene', { id: board })
      .then(async (scene) => {
        const shown = scene.elements.filter((el) => !el.isDeleted);
        if (!shown.length) return undefined;
        const appearance = boardAppearance(scene.board.paper, dark ? 'dark' : 'light');
        const blob = await exportToBlob({
          elements: shown as never,
          appState: {
            exportBackground: true,
            viewBackgroundColor: appearance.viewBackgroundColor,
            exportWithDarkMode: appearance.theme === 'dark',
          },
          files: null,
          mimeType: 'image/png',
          maxWidthOrHeight: 640,
          exportPadding: 24,
        });
        const url = URL.createObjectURL(blob);
        // An idle entry may finish normally; only an evicted entry has lost its URL ownership.
        if (pictures.get(key) !== created) {
          URL.revokeObjectURL(url);
          return undefined;
        }
        created.url = url;
        return url;
      })
      .catch(() => {
        // An older evicted request must not remove a newer retry for the same key.
        if (pictures.get(key) === created) pictures.delete(key);
        unused.delete(created);
        return undefined;
      });
    const created: Picture = { key, promise, users: 0 };
    pictures.set(key, created);
    picture = created;
  }
  const held = picture;
  held.users++;
  unused.delete(held);
  let released = false;
  return {
    promise: held.promise,
    release() {
      if (released) return;
      released = true;
      held.users--;
      if (held.users || pictures.get(key) !== held) return;
      unused.add(held);
      while (unused.size > UNUSED_PICTURES) retire(unused.values().next().value!);
    },
  };
}
