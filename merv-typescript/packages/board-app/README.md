# @merv/board-app

The board as a product of its own: the whiteboard, Pi, and a way between boards. No projects, tasks,
experiments, workers or sandboxes reach its people or its agent.

```bash
npm run board
```

That finds or starts a private PostgreSQL in `~/.merv/board`, builds the page, and serves one person
with no sign-in at the URL it prints. With `MERV_PI_MODEL_API_KEY` set Pi uses OpenAI, and with
`MERV_PI_ANTHROPIC_API_KEY` too it offers Claude; with neither Pi is a scripted stand-in and nothing
leaves the computer. `--scripted` forces the stand-in and `--build` rebuilds the page.

## How it is composed

`config/board.json` lists what it needs and nothing else: State, Scope, Identity, the API and its
tools, Blobs, the UI runtime, Board and this plugin. Merv's own `config/default.json` is untouched.
`config/board.hosted.example.json` is the same with sign-in on (Supabase, as Merv uses) and one
person's spending capped.

| Here                      | What it does                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `src/index.ts`            | Composes Pi and its tools, makes Pi's host project, and hands a lone person their credential |
| `src/machines.ts`         | What Fleet rents: a worker in this process. Pi needs Fleet; Fleet here needs no Sandboxes    |
| `src/words.ts`            | Pi's `surface`: what it is told and offered here, in this app's words                        |
| `ui/web/board-app/`       | The page: a title that switches boards, a line at the canvas's foot for Pi, nothing else     |
| `ui/vite.board.config.ts` | Builds it to `ui/dist-board`, beside Merv's `dist`                                           |

A person has one project, made and chosen as they first sign in, and never named to them. Each board
has its own conversation (`pi.create` keyed by the board's id). A first visit opens on a sample board
playing (`web/board-app/sample.ts`).

`words.ts` rewrites named sentences of the agent guide rather than copying it, so a sentence reworded
upstream shows up as a failure of `tests/board-app.test.ts`, which holds that nothing Pi is told or
offered names Merv's work.

Artifacts are out: pasted images are the board's own, and the Files tab, PDF figure crops and session
transcript cards go with them.
