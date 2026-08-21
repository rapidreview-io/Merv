# Task schema

> Settled with the founder 2026-08-20 and implemented the same day
> (structure-canonical): `task.create` takes the immutable goal prose +
> deliverables (migration 53), `brief.md` is rendered and pinned from them,
> and the delivery document carries one confirmation per deliverable plus
> Notes; resubmissions are the result versions.


One YAML skeleton, annotated, with field rules and a filled example.

```yaml
task:
  # ── identity ──────────────────────────────────────────────
  id:          task_…
  name:        prep-grokking-data        # folder-safe, unique in project
  status:      in_progress | in_review | done | failed

  # ── goal (the promise; the core, with deliverables) ───────
  # IMMUTABLE: fixed at creation, never edited. A wrong goal is an
  # honest miss or a failed task and a better new one — never a rewrite.
  goal:
    prose:  what needs to be done and why — to the point, standalone:
            a person just opening the task understands it with no
            surrounding context
    deliverables:                        # the list of things that need to happen
      - stated so it is verifiable AS WRITTEN — carries its own
        criterion (counts, tolerances, sections), no vague nouns
      - …

  # ── graph (structural relations to other work) ────────────
  depends_on: [ exp_… | task_… ]         # must succeed before this delivers
  unlocks:    [ exp_… | task_… ]         # derived: the nodes waiting on this

  # ── result (the fulfillment; VERSIONED — reviewers send back) ─
  result:
    versions:                            # append-only: v1, v2, …
      # each version is COMPLETE, not a diff — it answers every
      # deliverable; the latest version is the current result
      - v: 1
        confirmations:                   # 1:1 with goal.deliverables, by index
          - how to verify this deliverable, in short prose — pointers:
            a storage object, a file, a section of the lit review, a
            run receipt…
            # or an honest miss: "not delivered — <why>"; reviewer decides
          - …
        prose:  how the task was performed, briefly, plus anything
                else needed to verify the deliverables

  # ── review (one independent reviewer; one round per version) ─
  review:
    rounds:                              # round k judges result version k
      - v: 1
        verdict: pass | needs_changes | fail
        reason:  brief prose — required on send-back AND on approval;
                 the reviewer confirms each deliverable, one by one
      # needs_changes → the executor submits version k+1

  # ── ending (explicit, terminal) ───────────────────────────
  done:    { outcome }                   # owner accepts, on the record
  failed:  { reason, by: owner | reviewer }
```

The symmetry: **goal = prose + deliverables · result = confirmations + prose.**
The table is the pairing: deliverable | confirmed? | how to verify.

## Field rules

**goal.prose** — 2–4 sentences: what needs to be done, then why the project
needs it. Standalone: names datasets, tools, experiments by their own names;
never "the wave" / "this reflection". No method — how is the executor's.

**goal.deliverables** — one item = one thing, independently confirmable.
Each item carries its own acceptance criterion in the sentence (counts,
tolerances, required sections). No bundles ("X and Y" → two items), no vague
nouns ("good documentation"). Rule of thumb: 1–7 items; more usually means
this is two tasks.

**result.confirmations[i]** — 1–2 sentences answering deliverable i: where
the thing is and how to check it. Must point at something durable the
reviewer can open or replay — a file in the task folder, a storage object, a
lit-review section, a run receipt. Inline numbers are fine when a receipt
backs them. Bare assertion ("done, works") is not a confirmation.
Honest miss: "not delivered — <why>".

**result.prose** — one short paragraph (a few, at most): how the task was
performed, decisions taken, anything else needed to verify, what not to
trust blindly (caveats live here), and — after a send-back — what changed.

**review.reason** — 1–3 sentences. On approval: what was checked and why it
holds. On send-back: which deliverable failed and what exactly is missing.

## Example

```yaml
task:
  name: prep-grokking-data
  goal:
    prose: >
      Build one shared modular-addition dataset, model, and evaluation
      harness. The weight-decay and width sweeps (wd-sweep, width-sweep)
      must train and evaluate on identical, correct data and identical
      model/evaluation code.
    deliverables:
      - data/modadd_p97.npz holds every ordered (a,b) pair modulo 97 —
        9,409 triples — with a deterministic, disjoint half split from a
        recorded seed
      - model.py defines a one-layer Transformer with configurable d_model,
        returning 97 logits per (a,b)
      - eval.py prints labelled train and validation accuracy on CPU, and a
        fresh seeded default-width model scores within 0–3% of chance
  depends_on: []
  result:
    versions:
      - v: 1
        confirmations:
          - 9,409 rows, all targets == (a+b)%97; seed 20260819 in
            data/meta.json, overlap 0 — replay scripts/check_data.py and
            scripts/check_split.py (receipts in run r_3f1c)
          - Transformer(d_model=32) and (128) both build, 1 block, logits
            (B,97) — replay the python -c line in the run log
          - python eval.py → train_acc 0.0106 · val_acc 0.0098 vs chance
            0.0103 — run it from the repository root
        prose: >
          Generated all 97×97 pairs with numpy; a seeded permutation makes
          the half split. One pre-norm block with a learned equals token, so
          width is the only knob a sweep varies. The chance interval is wide
          by design — it guards against a broken pipeline, not leakage;
          check_split.py is the guard for that.
  review:
    rounds:
      - v: 1
        verdict: pass
        reason: >
          All three deliverables replay as pointed: dataset and split verify
          by their scripts, both widths build, eval output matches chance.
  done: { outcome: "Shared p=97 dataset, model, and evaluator verified;
          wd-sweep and width-sweep can build on them." }
```

Derived, never stored: status details, unlocks, timeline, confirmation counts.
Status itself derives from the pairing: a version awaiting its round = in_review;
sent back or nothing submitted = in_progress; pass+accept = done; fail = failed.

Decided: structure-canonical for the goal (create-time fields, immutable);
the result stays a submitted document per version, parsed into confirmations.
