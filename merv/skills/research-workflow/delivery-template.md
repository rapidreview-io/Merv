<!--
  Task delivery template.

  This file is the EVIDENCE of the task: one entry per brief check, so the
  reviewer can verify each one instead of reading a story. Copy it to the task
  delivery (tasks/<name>/delivery.md), fill it in, then submit it with
  artifact.submit (role "delivery") and run the returned upload command.

  REQUIRED spine — `task.transition(submit_delivery)` is blocked until:
    - Checks holds one numbered entry for EVERY check in the brief's "Done
      when", same numbering, none empty, no extras.

  RECOMMENDED — not lint-enforced:
    - Report — a few sentences of prose on the process: what was done, what
      was decided along the way, what changed after a review round.
    - Caveats

  Evidence, not narrative. Each entry gives what exists (files in the task
  folder, storage objects, run receipts, numbers) and, in plain prose, how the
  reviewer can check it. If a check is unmet, say so, why, and what was done
  instead — the reviewer decides; hiding it fails the review. Keep it under
  16 KB: point at files rather than pasting them.
-->

# Delivery: <task name>

## Checks
<!-- Same numbers as the brief. Start each entry with its state — [x] met,
     [ ] unmet, [~] partial — then the evidence, then " — how to check: " and
     how the reviewer can verify it (the UI reads those three parts into the
     requirements table; an entry with no box claims met). Examples:
     1. [x] out/{train,val,test}.parquet with 41 200 / 5 150 / 5 150 rows — how to check: ls out/ and open the data card's row-count table
     2. [x] check_overlap.py printed "0 overlapping ids" (see the sandbox run receipt) — how to check: rerun it from the task folder
     3. [ ] only 11 papers from 2023 on qualified after dedup — how to check: count the References section; the four dropped were preprints of listed papers -->
1. [x]
2. [x]

## Report
<!-- A few sentences on the process, for the reader rather than the reviewer:
     what was done, decisions taken along the way, what changed after a review
     round. Prose is fine here; evidence stays in Checks. -->

## Caveats
<!-- What the reviewer should know that the checks do not say: shortcuts,
     known gaps, anything a downstream experiment should not trust blindly. -->
