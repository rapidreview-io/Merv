# Autoresearch

A project's research loop, run by a manager agent of its own. For example: the person turns
it on with the goal _Find whether the baseline reproduces_ and a $10 cap. The manager starts an
experiment and waits. The experiment fails; the manager wakes with its result, notes _Baseline
failed to reproduce; started an ablation_, and waits again. When the cap leaves no room for
another run, the loop stops and Needs you asks the person to raise the cap or end the round.

It is off by default. A project admin turns it on, on the **Autoresearch** page or with
`autoresearch.write` (`configure`):

```json
{
  "action": "configure",
  "configure": {
    "enabled": true,
    "goal": "Find whether the baseline reproduces.",
    "capUsd": 10,
    "runEstimateUsd": 3,
    "wakeLimit": 20,
    "requestId": "turn-on-autoresearch"
  }
}
```

## The manager

The manager is an ordinary Sessions worker, not a separate agent system. Each project has one
`autoresearch@1` workflow instance. Its `managing` state carries a producer assignment, so
automatic dispatch offers it to a runner like any other step. Every later visit there continues
the same thread: the same actor and the same conversation, by the default continuity key
`[instance, 'managing', 'producer']` ([threads and their visits](AGENT_CONTINUITY.md)).

| State      | Meaning                                                             | Leaves by                                                             |
| ---------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `managing` | A manager visit reads what woke it and decides                      | `wait`, `end_round` (the manager); `pause`                            |
| `waiting`  | It waits for the work it started; nothing is dispatched             | `wake` (a run ended), `hear` (the person wrote); `pause`; `end_round` |
| `paused`   | It waits for the person: their own pause, the cap or the wake limit | `resume`; `end_round`                                                 |
| `idle`     | The round ended                                                     | `start_round`                                                         |
| `off`      | Turned off (terminal); turning it on again starts a new manager     |                                                                       |

A visit's assignment brief holds the standing instructions, the round's goal and spend, what
woke it, and what it started that still runs. The manager then does one of three things:

- **Schedules** the next work with `task.create` and `experiment.create`, the same tools and
  rules as anyone's. Autoresearch admits each start against the cap (below) and records it as
  one of the manager's runs.
- **Asks the person** with `session.ask_owner`, only for a decision it cannot make. Its visit
  ends, Needs you shows the question, and the answer comes back to the same conversation.
- **Ends its visit** with `autoresearch.decide`: `next: "wait"` for the work it started, or
  `next: "end"` with a summary. Its `note` (one line, at most 200 characters) is what the
  person reads about the decision. A wait on nothing is refused, unless the cap leaves no room
  for a run, in which case the loop pauses for the person.

Its grants are the project reads, `task.create`, `experiment.create` and `autoresearch.decide`
on its own instance and revision. It has no workspace. Experiments still refuse a create from
an experiment's own worker.

## The wake

Autoresearch's durable consumer (`autoresearch.wakes.v1`) listens to `workflow.transition`.
When a run of the manager's reaches a terminal state (done, failed, abandoned; a review that
passes or fails ends in one of these), it records a wake: the run's final state, whether that
counts as success, what its final move carried, its last own records (a failure's reason, a
review's verdict) and where to read the rest. If the manager is `waiting`, it is moved by `wake`
to `managing` and the waiting wakes are given to that visit. Wakes that arrive while it works
or is paused wait for its next visit. Startup re-reads every project whose loop is on.

The loop acts under the delegation of the admin who turned it on, which is checked again at
each move, as [continuous research](CONTINUOUS_RESEARCH.md) does. A refusal is published on the
manager's gate as an owner's move instead of failing the event.

## Spend cap

The cap is per round, in US dollars, and is built on Sandboxes' own accounting: the money
accrued plus the money reserved by live machines in the namespace linked to the project, since
the round began (the same report the spend page reads). A project without connected compute
spends nothing. Sandboxes' own monthly caps and credits still apply underneath.

While a run of the manager's is open, `runEstimateUsd` is held for it. A new run is admitted
only while `spent + estimate × open runs + estimate ≤ cap`. The check is a Workflows start
admission (`workflows.admitStarts`), inside the transaction that starts the task or
experiment, so a refused run creates nothing. The refusal is `autoresearch_cap_reached` (409)
with the spend in its message. A spend Sandboxes does not report in 5 seconds is unknown, never
zero, and refuses with `autoresearch_spend_unavailable` (503).

When nothing of the manager's runs and no further run fits, the loop pauses (`paused: cap`) and
Needs you asks the person to choose: raise the cap, which resumes the manager, or end the round.

## Wake limit

At most `wakeLimit` (default 20) automatic wakes in a row. When the limit is reached, the next
wake pauses the loop (`paused: wake_limit`) and Needs you says so. What finished stays queued.
Any time the person speaks, the count starts again: a message to the manager's thread (which
also wakes it to read the message), **Resume**, or a new round.

## Visibility and controls

The **Autoresearch** page and `autoresearch.read` (`status`) show:

- whether it is on;
- where the manager stands;
- the spend this round against the cap;
- the wakes used and queued;
- the runs it started;
- its lines, newest first: each decision, each wake, pause and resume.

A project writer can **Pause**, **Resume**, **End round** and start a **New round**. A project
admin changes the settings. Pausing a working manager ends its visit.

## Storage

`autoresearch` migration 1 creates:

- `autoresearch_projects`: settings and loop state, money in cents;
- `autoresearch_runs`: the work the manager started;
- `autoresearch_wakes`: one row per ended run, with the revision it was delivered at;
- `autoresearch_lines`: append-only, refusing update and delete;
- `autoresearch_commands`: request receipts.

Events are `autoresearch.enabled`, `disabled`, `decided`, `woken`, `paused`, `resumed` and
`reconcile`.

## Verification

`tests/autoresearch.test.ts` runs the default composition with fake agents. Each manager visit
is a real Sessions offer, and the test plays the agent through the manager's granted tools:

1. The manager starts an experiment and waits.
2. The experiment ends. The manager wakes in the same thread with its result and schedules the next.
3. The cap refuses a further run, creating nothing, and Needs you asks.
4. Raising the cap resumes the manager. The wake limit then pauses the loop, and the person's
   message to the thread resumes it.

A second test covers a task run, refusals of the person's and the manager's wrong moves, and
pause, resume and turning it off.
