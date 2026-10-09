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

`board.read` lists the boards, or says what one holds: frames, shapes with their text and rough place, link cards with what they open, and arrows with the shapes they join. `board.draw` makes every change in one call of composable operations: `note`, `box`, `text`, `link`, `arrow`, `frame`, `flow`, `edit`, `move` and `delete`. The agent never gives coordinates: a new shape goes `near` a shape, `in` a frame, or into the next free place, and Board works out where (`elements.ts`). Keys name what a call makes, so its later operations can point at it. To see a board as drawn (a sketch, a layout), the agent looks at it on the person's screen.

## What a board keeps

Rectangles, ellipses, diamonds, text, arrows, lines, freehand strokes and frames. Images, embeds and iframes are refused: a board keeps no files and loads nothing from elsewhere. A link is a web address, a Merv record or an in-app path. A board holds at most 5,000 live shapes; a page saves at most 500 shapes a call. Archived boards leave the list and stay retained. Writes need a producer or operator; everyone in the project reads.
