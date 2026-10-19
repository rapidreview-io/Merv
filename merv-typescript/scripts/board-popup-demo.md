# Local rich link popup

Run `node --import tsx scripts/board-popup-demo.ts` from merv-typescript, then open http://127.0.0.1:4399.
The page uses the real BoardCanvas and Excalidraw, with an in-memory local HTTP API fixture. Its paper metadata and artifact are labeled fixtures; no production state is accessed.

The native Excalidraw hyperlink popup retains its URL/open/edit/remove controls. A pinned, checked installation patch adds one renderer hook, allows its rich body to sit beside the selected shape, and removes the native 500 ms pointerleave dismissal when the hook is present. Escape, native outside selection, or the close control dismiss it. Native editing remains unchanged.

The `link` board.draw operation accepts optional `details: { title?, text?, preview?: { title, description? }, artifactId? }`. This stays in element.customData, is returned by board.read, and survives board.save/scene. Existing links work without details. An artifact target is loaded through the existing permission-checked ArtifactBody renderer. URL metadata is supplied by the caller; a bare URL has an honest hostname/open fallback. No arbitrary URL fetching or remote HTML embedding is added.

`patch-excalidraw-hyperlink.mjs` checks version 0.18.1 and exact source contexts in both published dev/prod builds and adds the type hook. An Excalidraw upgrade requires reviewing the patch; it fails rather than silently targeting changed internals. No DOM injection is used. It runs at postinstall.

Expansion is calibrated by content: URL-only cards have no Expand button. Brief notes expand to a viewport-bounded 760px reading surface (twice the base380px). Notes above1600 characters or24lines, and artifacts, open a true fullscreen document portal. Collapse and Escape return to the anchored popup; Close dismisses it. The expanded viewer traps keyboard focus and restores it on return.
