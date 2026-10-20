---
name: operations
description: Operate a Merv project. Read what is running and what stopped moving, steer workers with messages, and use dispatch, budget and machine controls. Use for status questions, stuck or slow work, workers, machines, cost and limits in Merv.
---

# Operating a Merv project

Merv dispatches ready work to agent sessions on machines. This skill is how to see that
machinery and steer it. Read first; every control below changes what runs.

## Read before acting

- `system.status`: the first read for any operational question. Dispatch, Fleet allocations,
  runners, sessions, waiting work, blockers and model-budget waits. It changes nothing; do not
  propose a control just to inspect.
- `session.read` (stuck): everything that stopped moving, and why. Each item has `kind`, `code`, `why`
  and `next`; why and next are advice, and the server still enforces every guard. Kinds include:
  - session_idle: no Merv call for a while. Not proof of a problem; it may be computing.
  - dispatch_held: withheld from automatic dispatch after failed launches.
  - work_blocked: something published a blocker, such as a worker's question to its owner
    (code `agent_question`, see the owners-agent skill).
  - work_waiting: waiting for its compute; it comes back by itself.
  - ready_quiet, dispatch_disabled, no_live_runner.
- `workflow.read` (status) with an `instanceId`: one work item's gate and blockers.
- `usage.read`: what closed sessions cost, in wall minutes (measured by Merv) and tokens
  (self-reported by the machine).

## Steering a worker

1. `session.read` (find) with the work's `instanceId` returns its current and latest session and the
   `threadId`; `session.read` (threads) lists the thread of every stage.
2. `session.read` (calls) with a `threadId` shows that thread's recent Merv calls;
   `session.read` (messages) shows the messages to it and the questions its agent asked.
3. `session.write` (message) with `threadId`, `body` and `requestId` queues a durable message that the
   live visit, or the next one, reads.

A pending message refuses the worker's next Merv calls until it acknowledges, so say everything
in one message and do not send one only to ask for status. A queued message is not proof it was
read, and an acknowledgement is not proof a correction was made. Messaging does not stop compute
or change an approved plan: for work that should end, halt it or end the record, then create
replacement work that refers to the earlier evidence.

## Controls (project admins)

- `session.write` (dispatch): turn automatic dispatch on or off.
- `session.write` (halt): close one session, or without a session id turn dispatch off and close all.
- `session.write` (release_hold): let dispatch offer a held target again once its cause is fixed.
- `session.write` (budget): bound agents' work in wall minutes or tokens, on the project or one item
  and what it depends on. Reaching it pauses automatic dispatch; nothing running is stopped.
- `workflow.write` (extend_limit): allow more rounds of an exhausted review loop (gate
  loop_limit_reached), with a reason.

## Machines

On a Merv server that runs Fleet and Sandboxes:

- `fleet` with action `list` or `get` reads the Fleet allocations the project's workers run on.
  Action `drain` stops admission, keeps the current assignment's results, then releases the
  machine; `halt` requests immediate deletion and may interrupt work.
- `sandboxes.sandbox` with action `list`, `get` or `providers` reads rented machines and the
  providers available. Action `delete` deletes one machine and everything on it, so retain what
  you need first.

## Money and limits

A dollar budget covers only compute rented through Sandboxes: machines, GPUs and storage.
Agents' own model use, reviews included, counts in tokens against the person's Fleet daily
limit and is never priced in dollars. Do not ask for a dollar budget for work that rents no
compute, and never write a dollar cap for agents or reviews.
