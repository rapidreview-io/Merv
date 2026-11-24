/**
 * A long chat keeps the reader's place while it changes: a trail stays mounted as its window moves, a section keeps
 * its key through a page added above it, and the scroll stays where they were reading through a new word, a page
 * loaded above or a diagram drawn in. The page's own scrolls are told apart from the reader's.
 */
import { useCallback, useEffect, useRef } from 'react';
import { type Block, type sectionsOf } from './chat-events';

type Section = ReturnType<typeof sectionsOf>[number];
export type StableSection = Section & { renderKey: string };
/** A retained tool keeps its trail mounted when either edge of its window moves. */
export function stableBlocks(previous: Block[], next: Block[]): Block[] {
  const trails = previous.filter((block) => block.type === 'trail'),
    keys = new Set(next.filter((block) => block.type !== 'trail').map((block) => block.key));
  return next.map((block) => {
    if (block.type !== 'trail') return block;
    const before = trails.find((trail) =>
      trail.steps.some((step) => block.steps.some((next) => next.item === step.item)),
    );
    let key = before && !keys.has(before.key) ? before.key : block.key;
    while (keys.has(key)) key += ':';
    keys.add(key);
    return { ...block, key };
  });
}
/** Prepends must not remount an expanded trail or its enclosing turn. */
export function stableSections(previous: StableSection[], next: Section[]): StableSection[] {
  const identities = (section: Section) =>
    new Set(
      section.blocks.flatMap((block) =>
        block.type === 'trail' ? block.steps.map((step) => `tool:${step.item}`) : [block.key],
      ),
    );
  const old = previous.map((section) => ({ section, ids: identities(section) }));
  const used = new Set<string>();
  return next.map((section) => {
    const ids = identities(section);
    const prior = old.find(
      (before) =>
        before.section.undone === section.undone && [...ids].some((id) => before.ids.has(id)),
    )?.section;
    const candidate = prior?.renderKey;
    const renderKey =
      candidate && !used.has(candidate) ? candidate : `section:${section.key}:${section.undone}`;
    used.add(renderKey);
    return { ...section, renderKey, blocks: stableBlocks(prior?.blocks ?? [], section.blocks) };
  });
}
function scrollAnchor(root: HTMLElement) {
  const top = root.getBoundingClientRect().top;
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>('[data-scroll-anchor], [data-block-id]'),
  );
  const visible = (node: HTMLElement) => node.getBoundingClientRect().bottom > top;
  const node =
    nodes.find(
      (node) =>
        visible(node) &&
        (!node.classList.contains('trail') || !node.querySelector('[data-scroll-anchor]')),
    ) ?? nodes.find(visible);
  return node
    ? {
        id: node.dataset.scrollAnchor ?? node.dataset.blockId!,
        offset: node.getBoundingClientRect().top - top,
      }
    : undefined;
}
function restoreScrollAnchor(root: HTMLElement, anchor: ReturnType<typeof scrollAnchor>) {
  if (!anchor) return;
  const node = Array.from(
    root.querySelectorAll<HTMLElement>('[data-scroll-anchor], [data-block-id]'),
  ).find((node) => (node.dataset.scrollAnchor ?? node.dataset.blockId) === anchor.id);
  if (node)
    nudge(
      root,
      node.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset,
    );
}
/** A write of nothing still stops a fling in WebKit: only a real difference moves the page. */
function nudge(root: HTMLElement, by: number) {
  if (Math.abs(by) >= 0.5) {
    root.scrollTop += by;
    written.set(root, root.scrollTop);
  }
}
/** Where the page itself last put each list. Its scroll event arrives a frame later, often just
 *  after the reader's first wheel step up: read as theirs, it said they were back at the end and
 *  the next word pinned them there again, so a running chat could not be scrolled away from. */
const written = new WeakMap<HTMLElement, number>();
export function toEnd(root: HTMLElement) {
  root.scrollTop = root.scrollHeight;
  written.set(root, root.scrollTop);
}
/** Whether this scroll event only reports a move the page made itself. */
export function echoed(root: HTMLElement) {
  const top = written.get(root);
  written.delete(root);
  return top !== undefined && Math.abs(root.scrollTop - top) < 1;
}

/** Where the reader is, read while React renders the change that will move it, and put back as
 *  that change commits. Render and commit run in one task, so no scroll of theirs falls between.
 *  Read when the change was announced instead (a streamed word, a page on its way), it was put
 *  back after their next wheel step and undid it: the page shook under their fingers. */
export function useHeldScroll(root: () => HTMLElement | null | undefined, holds = () => true) {
  const wanted = useRef(false),
    anchor = useRef<ReturnType<typeof scrollAnchor>>();
  const element = wanted.current ? root() : undefined;
  if (element) anchor.current = holds() ? scrollAnchor(element) : undefined;
  return {
    hold: () => {
      wanted.current = true;
    },
    /** In a layout effect of the commit that changed the content. */
    restore: () => {
      const element = root(),
        kept = anchor.current;
      wanted.current = false;
      anchor.current = undefined;
      if (element && kept) restoreScrollAnchor(element, kept);
      return !!kept;
    },
    drop: () => {
      wanted.current = false;
      anchor.current = undefined;
    },
  };
}

/** A rich result announces its local replacement around the React commit. Keep the
 *  current reading position without watching every mutation in a long transcript. */
export function preserveRichScroll(root: HTMLElement, following: () => boolean) {
  let pending = false;
  let anchor: ReturnType<typeof scrollAnchor>;
  let content: { node: HTMLElement; offset: number } | undefined;
  const before = () => {
    // Each announcement reads afresh: a reading left over from one that never committed is stale.
    pending = true;
    anchor = undefined;
    content = undefined;
    if (!following()) {
      anchor = scrollAnchor(root);
      const { top, bottom } = root.getBoundingClientRect();
      // A single answer can fill many screens. Keep its visible paragraph/row in
      // place when a diagram higher in that same message changes height.
      const node = Array.from(
        root.querySelectorAll<HTMLElement>(
          '.prose > p, .prose li, .prose tr, .prose pre:not([data-find-ignore]), .prose-math-display, .prose-mermaid',
        ),
      ).find((node) => {
        if (node.closest('details:not([open])')) return false;
        const bounds = node.getBoundingClientRect();
        if (bounds.bottom <= top || bounds.top >= bottom) return false;
        for (
          let parent: HTMLElement | null = node;
          parent && parent !== root;
          parent = parent.parentElement
        )
          if ((parent.dataset.scrollAnchor ?? parent.dataset.blockId) === anchor?.id) return true;
        return false;
      });
      if (node) content = { node, offset: node.getBoundingClientRect().top - top };
    }
  };
  const after = () => {
    if (!pending) return;
    pending = false;
    if (following()) toEnd(root);
    else if (content && root.contains(content.node))
      nudge(
        root,
        content.node.getBoundingClientRect().top -
          root.getBoundingClientRect().top -
          content.offset,
      );
    else restoreScrollAnchor(root, anchor);
    anchor = undefined;
    content = undefined;
  };
  root.addEventListener('merv-rich-before-update', before);
  root.addEventListener('merv-rich-after-update', after);
  return () => {
    root.removeEventListener('merv-rich-before-update', before);
    root.removeEventListener('merv-rich-after-update', after);
  };
}

/** Coalesce live changes without dropping words between browser frames. */
export function useFrame(flush: () => void) {
  const latest = useRef(flush);
  latest.current = flush;
  const cancel = useRef<() => void>();
  useEffect(
    () => () => {
      cancel.current?.();
      cancel.current = undefined;
    },
    [],
  );
  return useCallback(() => {
    if (cancel.current) return;
    const run = () => {
      cancel.current = undefined;
      latest.current();
    };
    if (typeof requestAnimationFrame === 'function') {
      const frame = requestAnimationFrame(run);
      cancel.current = () => window.cancelAnimationFrame(frame);
    } else {
      const timer = setTimeout(run, 16);
      cancel.current = () => clearTimeout(timer);
    }
  }, []);
}
