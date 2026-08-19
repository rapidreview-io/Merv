<!--
  Task brief template.

  This file is the CONTRACT of the task: it is what the executor works to and
  what the task reviewer verifies the delivery against. Copy it to the task
  brief (tasks/<name>/brief.md), fill it in, then submit it with
  artifact.submit (role "brief") and run the returned upload command. A task
  proposed by a reflection wave arrives with this file already pinned.

  REQUIRED spine — `task.transition(submit_delivery)` is blocked until each of
  these has real content (the lint strips these HTML comments):
    - Goal
    - Done when — a numbered list (1. 2. 3.) of checks

  RECOMMENDED — not lint-enforced:
    - Scope
    - Context

  Be specific about outcomes, silent about method. Checks, not steps: say what
  must be true when the task is done and how someone else could verify it, not
  how to get there — the how belongs to whoever executes. Keep it under one
  page.
-->

# Brief: <task name>

## Goal
<!-- One paragraph: what this task must achieve and why the project needs it.
     Which experiments or decisions wait on it? -->

## Done when
<!-- Numbered checks. Each one names a fact that must be true when the task is
     done, plus how it can be verified. Examples:
     1. train/val/test parquet files exist under out/ — verify: row counts match the data card
     2. no id appears in more than one split — verify: run scripts/check_overlap.py, expect 0
     3. the survey covers at least 15 papers from 2023 on — verify: count the References section
     Keep them checkable. "The data is good" is not a check. -->
1.
2.

## Scope
<!-- In / out, constraints (must / must not), limits if any (time, compute).
     Enough that the executor stays inside the goal without being told how. -->

## Context
<!-- What to read first, where inputs live, and what this task depends on
     (other tasks or experiments). -->
