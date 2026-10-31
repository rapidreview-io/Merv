/**
 * The shapes that stand at any point of a board's history, moved either way at once. Each version
 * of each shape is restored once and kept as the one object, which is what Excalidraw caches what it
 * has drawn by, so going back over ground already covered redraws nothing. Moving is walking the
 * units between here and there, however long the history.
 */
import { stacked, type BoardElement } from '@merv/board/models';
import type { Timeline } from './board-timeline';

interface Version {
  raw: BoardElement;
  rank: number;
  /** What it replaced, to go back to. */
  was?: Version;
  /** The shape a label stands in, measured with it. */
  holder?: Version;
}
/** Makes a scene's shape of a version of one, and of the shape it stands in, if any. */
export type Restore<T> = (raw: BoardElement, holder?: BoardElement) => T | undefined;

export class BoardFilm<T> {
  /** How many of the timeline's units have landed. */
  at = 0;
  /** The shapes that stand now. */
  readonly standing = new Set<string>();
  private current = new Map<string, Version>();
  private versions: Version[][];
  private scene_?: T[];
  constructor(
    private line: Timeline,
    private restore: Restore<T>,
    private made = new WeakMap<BoardElement, { shape: T | undefined }>(),
  ) {
    const ranks = new Map(
      stacked(line.units.flatMap(({ shapes }) => shapes)).map((raw, rank) => [raw, rank]),
    );
    const latest = new Map<string, Version>();
    this.versions = line.units.map(({ shapes }) => {
      const landing = shapes.map((raw): Version => {
        const version: Version = { raw, rank: ranks.get(raw)!, was: latest.get(raw.id) };
        latest.set(raw.id, version);
        return version;
      });
      for (const version of landing) {
        const holder = version.raw.containerId;
        if (typeof holder === 'string') version.holder = latest.get(holder);
      }
      return landing;
    });
  }
  /** The same film, with more history on the end of its timeline and standing where this one does. */
  longer(line: Timeline) {
    const film = new BoardFilm(line, this.restore, this.made);
    film.seek(this.at);
    return film;
  }
  /** Moves to this many units landed. */
  seek(to: number) {
    const target = Math.max(0, Math.min(this.versions.length, to));
    if (target === this.at) return;
    this.scene_ = undefined;
    for (; this.at < target; this.at++)
      for (const version of this.versions[this.at]!) this.put(version.raw.id, version);
    for (; this.at > target; this.at--) {
      const landing = this.versions[this.at - 1]!;
      for (let i = landing.length - 1; i >= 0; i--) this.put(landing[i]!.raw.id, landing[i]!.was);
    }
  }
  private put(id: string, version: Version | undefined) {
    if (version) this.current.set(id, version);
    else this.current.delete(id);
    if (version && !version.raw.isDeleted) this.standing.add(id);
    else this.standing.delete(id);
  }
  /** A version's shape as a scene holds it, the one object however often it is asked for. */
  shape({ raw, holder }: Version) {
    let made = this.made.get(raw);
    if (!made) this.made.set(raw, (made = { shape: this.restore(raw, holder?.raw) }));
    return made.shape;
  }
  /** What stands now, in the order it stacks. */
  scene(): readonly T[] {
    return (this.scene_ ??= [...this.current.values()]
      .filter(({ raw }) => !raw.isDeleted)
      .sort((a, b) => a.rank - b.rank)
      .flatMap((version) => {
        const shape = this.shape(version);
        return shape === undefined ? [] : [shape];
      }));
  }
  /** The shape that stands as this version of it, if this film holds that version. */
  held(id: string, version: number, versionNonce: number) {
    const standing = this.current.get(id);
    return standing?.raw.version === version && standing.raw.versionNonce === versionNonce
      ? this.shape(standing)
      : undefined;
  }
}
