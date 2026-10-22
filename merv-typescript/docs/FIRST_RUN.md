# First-run tour

Shipped 2026-10-22 (`packages/ui/web/tour.tsx`). Prototype: https://claude.ai/artifact/PCfr3jbeHnWU1gQMzYV9LJ.

- Opens once per person, the first time they open a project in this browser (`merv:tour-seen:<person>` in localStorage). Skip and Done both mark it seen.
- Settings › Session › **Take the tour** replays it from step 1.
- Each step lights its rail rows (`data-tour` on the row, from the row's view kind) through a dimmed page and shows one short card beside them. Arrow keys move, Escape leaves. A step whose row the project does not register is left out. The tour opens no page, because opening Pi rents a machine.
- On phones the card is a bottom sheet.

| Step             | Lights       | Card                                                               |
| ---------------- | ------------ | ------------------------------------------------------------------ |
| Project switcher | project name | Hop between your projects here.                                    |
| Home             | Home         | Everything about your project, at a glance.                        |
| Work             | Work         | Your tasks and experiments.                                        |
| Pi               | Pi           | The built-in agent that runs the whole show. Try voice, it’s good. |
| Board            | Board        | A whiteboard you and your agent draw on, yours or Pi.              |
| Compute          | Compute      | GPU boxes on offer, and what your agents are renting.              |
| Git and Files    | Git, Files   | Every commit and file your agents ship.                            |
| Discord          | Discord      | Come say hi.                                                       |
| Settings         | Settings     | Replay this tour anytime.                                          |

Shipped with it: the sidebar’s **Discord →** row (Discord’s own logo) just above the account (https://discord.gg/p8h6MwpNv), and the plugin's research skill line saying the UI is at https://experiments.rapidreview.io/ui/ and to open it for the person when they need to see it.

Open: store "seen" on the account instead of the browser, so a second machine does not tour again.
