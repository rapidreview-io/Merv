# Experiment schema

> Settled with the founder 2026-08-20 and implemented the same day:
> `experiment.create` takes the intent (the ask, one standalone line) plus
> an optional free-prose `details` field (migration 54). Both are immutable.
> The plan remains the contract, formed through design review; it supersedes
> `details` on anything about *how*.

One YAML skeleton, annotated, with field rules and a filled example.

```yaml
experiment:
  # ── identity ──────────────────────────────────────────────
  id:      exp_…
  name:    wd-sweep          # folder-safe, unique in project; names the
                             # CONTRAST with siblings, not the project topic
  status:  planned | design_review | ready_to_run | running
           | experiment_review | complete | failed | abandoned

  # ── born with (immutable; the handoff to the planner) ─────
  intent:  one line, written as the ASK, not a title: what this tests and
           why, standalone (names its harness, dataset, sibling; never
           "the wave"). When details is empty, this line is the planner's
           whole handoff. Doubles as the UI title.
  details: optional free prose, any length, addressed to the planner:
           givens, boundaries with siblings, preferences, budgets,
           warnings — up to a full sketch of the design. Empty is fine;
           intent alone is a complete create.
  tested_claims: [ claim_… ]
  depends_on:    [ exp_… | task_… ]   # wave DAG edges, e.g. the prep task

  # ── plan (the contract; versioned through design review) ──
  plan:
    versions:                          # append-only: v1, v2, …
      - v: 1
        sections: Summary · Objective & hypothesis · Method · Evaluation
                  · Risks & confounders
  design_review:
    rounds:                            # round k judges plan version k
      - v: 1
        verdict: pass | needs_changes
        reason:  …                     # anchor: does this plan answer the
                                       # intent, and engage the details?

  # ── report (the fulfillment; reviewed) ────────────────────
  report:
    versions:
      - v: 1
        sections: Summary · Results · Deviations from plan · Conclusion
  experiment_review:
    rounds: [ { v: 1, verdict: pass | needs_changes, reason: … } ]

  # ── ending (explicit, terminal) ───────────────────────────
  complete: { conclusion }             # after a passing experiment review
  failed | abandoned: { reason }
```

One rule resolves everything: **intent + details are the ask; the plan is
the contract.** Once a plan passes design review it supersedes the details
on anything about *how*; the intent's question stands for the experiment's
whole life. A wrong ask is an abandoned experiment and a better new one —
never a rewrite.

The symmetry with tasks — both are born with a standalone ask; they differ
in when the contract forms:

    task:        goal + deliverables — contract fixed at birth
    experiment:  intent + details — the ask at birth; the plan becomes
                 the contract after design review

## Field rules

**intent** — the ask in one standalone line (what + why), not a vague
headline. The same authoring rule tasks follow: name datasets, tasks, and
sibling experiments by their own names; never "the wave". Reviewer-enforced,
not a lint.

**details** — no shape requirements: empty, one line, or pages. Not parsed,
not validated, never blocks anything. Its force is procedural: the planner
must engage it (adopt each point, or argue in the plan why not) and design
review checks that they did. After the plan is approved, details are
history — the plan is the only contract.

## Example

```yaml
experiment:
  name: wd-sweep
  intent: Establish whether weight decay controls when grokking happens
          on the shared p=97 harness from prep-modadd-data — the timing
          claim depends on it
  details: >
    Train the harness model unchanged at the default width, varying only
    weight decay; width belongs to width-sweep. Prefer at least five
    decay values spanning 0–0.3 on a roughly log grid. The timing metric
    is the planner's call, but it must be robust to checkpoint spacing —
    the pilot got burned by sparse evals. Budget: about one GPU-day.
  tested_claims: [claim_2f31]
  depends_on: [task_prep-modadd-data]
```

Drop the details and the create is still complete — the intent alone
carries the question. Keep them and the planner starts with boundaries,
preferences, one warning, and a budget — none of it binding: if the grid
cannot fit one GPU-day, the plan says so and design review decides.

UI: the experiment page opens with the permanent Intent card; details sit
behind its header disclosure; the figure, report, and plan follow.
