<!--
  Task delivery template.

  This file is the FULFILLMENT of the task: one confirmation per deliverable,
  so the reviewer verifies each one instead of reading a story. Copy it to
  tasks/<name>/delivery.md, fill it in, then submit it with artifact.submit
  (role "delivery") and run the returned upload command. Resubmitting after a
  needs_changes review creates the next version — each version is COMPLETE
  (answers every deliverable), never a diff.

  REQUIRED spine — `task.transition(submit_delivery)` is blocked until:
    - Confirmations holds one numbered entry for EVERY deliverable in the
      goal, same numbering, none empty, no extras.

  RECOMMENDED — not lint-enforced:
    - Notes

  Pointers, not narrative. Each confirmation says where the thing is and how
  to check it — a file in the task folder, a storage object, a lit-review
  section, a run receipt. Inline numbers are fine when a receipt backs them;
  bare assertion ("done, works") is not a confirmation. If a deliverable did
  not happen, say so plainly: "not delivered — <why>" — the reviewer decides;
  hiding it fails the review. Keep it under 16 KB.
-->

# Delivery: <task name>

## Confirmations
<!-- Same numbers as the goal's deliverables. Examples:
     1. out/{train,val,test}.parquet with 41 200 / 5 150 / 5 150 rows — how to check: ls out/ and open the data card's row-count table
     2. check_overlap.py printed "0 overlapping ids" (receipt in run r_3f1c) — how to check: rerun it from the task folder
     3. not delivered — only 11 papers from 2023 on qualified after dedup; the four dropped were preprints of listed papers -->
1.
2.

## Notes
<!-- One short paragraph: how the task was performed, decisions taken,
     anything else needed to verify the deliverables, and what not to trust
     blindly. After a send-back: what changed. -->
