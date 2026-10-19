# @merv/board

Board keeps a project's whiteboards: unlimited boards per project, for ideas. People draw on them in Excalidraw on the **Board** page, and their agents draw on them with `board.draw`. A board is a living record, not a file: each shape is stored at its newest version, so a person, a colleague and an agent drawing at once merge shape by shape, as Excalidraw itself reconciles. It creates no workflow and is never part of a record of the work.

## Where it sits

Board requires State and Scope and nothing else. A card that links to a task, an experiment, a file or a paper keeps only that record's id (`merv:<id>`, or a web address); the page names and opens it through `project.references`, as a link in any text is, so Board reads nothing of other plugins and none of them knows boards exist. Its row declares `opens: 'board_'`, so a board's id opens on its page wherever it is named.

| Entry               | Requires     | Adds                                                                                                                                                       |
| ------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@merv/board`       | State, Scope | Boards, their shapes and revisions; `board.created`, `board.changed` and `board.set` events                                                                |
| `@merv/board/tools` | Board, Tools | `board.read` and `board.draw` for agents, a short guide paragraph; `board.scene`, `board.save` and `board.set` for the page only (`conversation: 'never'`) |
| `@merv/board/ui`    | Board, UI    | The Board row under Research                                                                                                                               |

## The agent's two tools

`board.read` lists the boards, or says what one holds: frames, shapes with their text and rough place, link cards with what they open, and arrows with the shapes they join. `board.draw` makes every change in one call of composable operations: `note`, `box`, `text`, `link`, `arrow`, `frame`, `flow`, `edit`, `move` and `delete`. A new shape goes `near` a shape (the nearest room around it, on a `side` if asked), `in` a frame, `at` an exact corner in the coordinates `board.read` reports, or into the next free place; Board works out the rest (`elements.ts`). `sketch` draws pen strokes from SVG path data (`path.ts`). Keys name what a call makes, so its later operations can point at it. To see a board as drawn (handwriting, a sketch, a layout), the agent looks at it by its id: Board contributes an actual Excalidraw image renderer to Tools (`renderer.ts`, fitted to a `focus` or camera region), so the look needs nobody's screen.

## What a board keeps

Rectangles, ellipses, diamonds, text, arrows, lines, freehand strokes and frames. Images, embeds and iframes are refused: a board keeps no files and loads nothing from elsewhere. A link is a web address, a Merv record or an in-app path. A board holds at most 5,000 live shapes; a page saves at most 500 shapes a call. A deleted shape is kept 30 days, so a page that missed its deletion still learns of it; after that the board's next change purges it (at most 500 a change), and a page asking for what changed since before a purged deletion is handed every live shape, marked `whole`, in place of the changes. Archived boards leave the list and stay retained. Writes need a producer or operator; everyone in the project reads.

## Direct visual feedback

`screen.look` with `at.record` naming a board returns a JPEG exported by the same Excalidraw
package as the editor, directly to the agent. The offline Chromium renderer restores elements
and bindings, loads bundled fonts before measuring text, and never changes the stored scene.
New sketch paths use native lines with zero roughness and fixed widths; saved freehand drawings
remain intact. Notes, labeled boxes, text, frames, links and flows retain their existing inputs.

Optional `view` accepts `fit`, `region` (`x`, `y`, `width`, `height`), `pan` (`dx`, `dy`), or `zoom`
(`factor`, optional `center`). Coordinates are board units. An omitted view preserves that
conversation's last camera on this board; `at.focus` fits a shape, frame or sketch group.
Camera state expires after an hour and on server restart. Up to 1,000 recent cameras are kept.
The renderer bounds image size and rendering time, closes failed pages, and restarts a disconnected
browser. Pi retains the two most recent images in model requests and clips older views when
saving bounded conversation history; inspect the board again when returning to an older detail.
Other pages retain their existing text-description feedback.

`npm run build` packages the offline browser bundle and font manifest. For source development,
run `npm run build:board-renderer` once after installing dependencies. Chromium is the existing
production Playwright runtime used by Reports. `tests/board-vision.test.ts` also accepts
`MERV_TEST_CHROME` to select a local browser executable.
