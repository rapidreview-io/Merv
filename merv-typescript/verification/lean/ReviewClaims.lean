/-!
A one-review abstraction of `ReviewService` claim admission, submission, and
durable revocation delivery. The pinned snapshot is opaque. Commands are
well-formed and tenant-scoped; `permitted`, `independent`, and `live` are the
results of the service's current external checks, not historical facts.
Submission request IDs and verdict assessment/routing are outside this model.
`startEventId` and revocation IDs preserve the ordering of committed events.
-/

namespace Merv.ReviewClaims

inductive Status where
  | requested | started | submitted
  deriving Repr, BEq, Inhabited

structure Store where
  pinned : String
  status : Status := .requested
  generation : Nat := 0
  reviewer : Option String := none
  claimId : Option String := none
  startEventId : Nat := 0
  verdict : Option String := none
  deriving Repr, BEq, Inhabited

inductive Command where
  | start (actor newClaim : String) (eventId : Nat)
      (permitted independent live : Bool)
  | submit (actor claim verdict : String)
      (permitted independent live : Bool)
  | revoke (actor : String) (eventId : Nat)
  | release (actor claim : String)
  deriving Repr, Inhabited

inductive Outcome where
  | claimed | existing | submitted | released | unchanged
  | forbidden | independence | unavailable | closed | staleClaim
  deriving Repr, BEq, Inhabited

structure Result where
  store : Store
  outcome : Outcome
  deriving Repr, Inhabited

def reject (s : Store) (o : Outcome) : Result := ⟨s, o⟩

def step (s : Store) : Command → Result
  | .start actor newClaim eventId permitted independent live =>
      if !permitted then reject s .forbidden
      else if !independent then reject s .independence
      else if s.status == .requested then
        ⟨{ s with status := Status.started, generation := s.generation + 1, reviewer := some actor, claimId := some newClaim, startEventId := eventId }, .claimed⟩
      else if s.status == .started && s.reviewer == some actor then
        if live then reject s .existing else reject s .staleClaim
      else reject s .unavailable
  | .submit actor claim verdict permitted independent live =>
      if !permitted then reject s .forbidden
      else if s.status != .started then reject s .closed
      else if s.reviewer != some actor || !independent then reject s .independence
      else if !live || s.claimId != some claim then reject s .staleClaim
      else ⟨{ s with status := Status.submitted, verdict := some verdict }, .submitted⟩
  | .revoke actor eventId =>
      if s.status == .started && s.reviewer == some actor &&
          s.startEventId < eventId then
        ⟨{ s with status := Status.requested, reviewer := none, claimId := none }, .released⟩
      else reject s .unchanged
  | .release actor claim =>
      if s.status == .started && s.reviewer == some actor &&
          s.claimId == some claim then
        ⟨{ s with status := Status.requested, reviewer := none, claimId := none }, .released⟩
      else reject s .unchanged

theorem pinned_immutable (s : Store) (c : Command) :
    (step s c).store.pinned = s.pinned := by
  cases c <;> simp only [step]
  all_goals repeat (first | split | simp_all [reject])

theorem submitted_terminal (s : Store) (c : Command)
    (h : s.status = .submitted) : (step s c).store = s := by
  have noRequest : ((Status.submitted == Status.requested) = false) := by decide
  have noStarted : ((Status.submitted == Status.started) = false) := by decide
  have isNotStarted : ((Status.submitted != Status.started) = true) := by decide
  cases c <;> simp [step, h, noRequest, noStarted, isNotStarted, reject]
  all_goals repeat (first | split | rfl)

theorem generation_never_decreases (s : Store) (c : Command) :
    s.generation ≤ (step s c).store.generation := by
  cases c <;> simp only [step]
  all_goals repeat (first | split | simp_all [reject])

theorem stale_claim_cannot_submit (s : Store) (actor claim verdict : String)
    (permitted independent live : Bool)
    (stale : s.claimId != some claim) :
    (step s (.submit actor claim verdict permitted independent live)).outcome ≠
      .submitted := by
  simp only [step]
  repeat (first | split | simp_all [reject])

theorem older_revocation_cannot_release (s : Store) (actor : String)
    (eventId : Nat) (old : eventId ≤ s.startEventId) :
    (step s (.revoke actor eventId)).store = s := by
  simp [step, Nat.not_lt_of_ge old, reject]

theorem wrong_claim_release_unchanged (s : Store) (actor claim : String)
    (wrong : s.claimId != some claim) :
    (step s (.release actor claim)).store = s := by
  simp only [step]
  repeat (first | split | simp_all [reject])

def trace (s : Store) (commands : List Command) : Store :=
  commands.foldl (fun current command => (step current command).store) s

theorem trace_pinned_immutable (s : Store) (commands : List Command) :
    (trace s commands).pinned = s.pinned := by
  induction commands generalizing s with
  | nil => rfl
  | cons command rest ih =>
      change (trace (step s command).store rest).pinned = s.pinned
      rw [ih, pinned_immutable]

theorem trace_submitted_terminal (s : Store) (commands : List Command)
    (submitted : s.status = .submitted) : trace s commands = s := by
  induction commands generalizing s with
  | nil => rfl
  | cons command rest ih =>
      simp only [trace, List.foldl_cons]
      rw [submitted_terminal s command submitted]
      exact ih s submitted

theorem successful_submit_requires_current_checks
    (s : Store) (actor claim verdict : String)
    (permitted independent live : Bool)
    (success : (step s (.submit actor claim verdict permitted independent live)).outcome =
      .submitted) :
    permitted = true ∧ s.status = .started ∧ s.reviewer = some actor ∧
      independent = true ∧ live = true ∧ s.claimId = some claim := by
  simp only [step] at success
  repeat (first | split at success | simp_all [reject])
  all_goals cases hs : s.status <;> simp_all [bne]
  case isFalse.isFalse.isFalse.isFalse.requested =>
    have impossible : (Status.requested == Status.started) = false := by decide
    simp_all
  case isFalse.isFalse.isFalse.isFalse.submitted =>
    have impossible : (Status.submitted == Status.started) = false := by decide
    simp_all

end Merv.ReviewClaims
