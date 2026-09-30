import Workflow

/-!
An admitted transition extends the core transition model with the ordering of
`transitionInternal` and the owning program handle's entry check.

Inputs represent observed outcomes of external systems: scope permission,
registration identity, awaited policy/context checks,
and live registration checks. The model proves consequences of those outcomes;
it does not prove the external predicates themselves. `activeAfterWrite = false`
models failure of the final registration check after writes in an engine-owned
transaction. The workflow projection rolls back on that uncaught failure.
Calls using a supplied transaction require its owner to roll back on failure.
The command is already syntactically valid and refers to an existing instance.
-/

namespace Merv.Admission

open Merv.Workflow

structure Environment where
  handleActiveAtEntry : Bool := true
  mayRead : Bool := true
  ownerMatchesSnapshot : Bool := true
  installed : Bool := true
  handleActiveAtReplay : Bool := true
  postEdgeError : String := ""
  activeBeforeWrite : Bool := true
  activeAfterWrite : Bool := true
  deriving Repr, Inhabited

structure Result where
  store : Store
  kind : String
  response : Snapshot
  committed : Bool
  deriving Repr, Inhabited

def denied (s : Store) (code : String) : Result :=
  { store := s, kind := code, response := s.current, committed := false }

def fromCore (r : Merv.Workflow.Result) : Result :=
  let (kind, response) := match r.outcome with
    | .committed snapshot => ("committed", snapshot)
    | .replayed snapshot => ("replayed", snapshot)
    | .revisionConflict => ("revision_conflict", r.store.current)
    | .requestConflict => ("request_conflict", r.store.current)
    | .invalidTransition => ("invalid_transition", r.store.current)
    | .guardRejected => ("guard_rejected", r.store.current)
  { store := r.store, kind, response,
    committed := match r.outcome with | .committed _ => true | _ => false }

theorem fromCore_committed (r : Merv.Workflow.Result)
    (successful : (fromCore r).committed = true) :
    ∃ snapshot, r.outcome = .committed snapshot ∧
      (fromCore r).store = r.store := by
  cases h : r.outcome with
  | committed snapshot => exact ⟨snapshot, rfl, rfl⟩
  | replayed _ => simp [fromCore, h] at successful
  | revisionConflict => simp [fromCore, h] at successful
  | requestConflict => simp [fromCore, h] at successful
  | invalidTransition => simp [fromCore, h] at successful
  | guardRejected => simp [fromCore, h] at successful

-- Public commands require an owning handle. The current engine always checks
-- read permission; the program owns action-specific write/review authorization.
-- The target instance is assumed to exist in the caller's project.
def preflightError (e : Environment) : Option String :=
  if !e.handleActiveAtEntry then some "workflow_unavailable"
  else if !e.mayRead then some "forbidden"
  else if !e.ownerMatchesSnapshot then some "workflow_handle_mismatch"
  else none

def step (g : Graph) (s : Store) (c : Command) (e : Environment) : Result :=
  match preflightError e with
  | some code => denied s code
  | none =>
      match receiptFor s c.requestId with
      | some prior =>
          -- `replay` checks the fingerprint before `requireActive(owner)`.
          if prior.fingerprint != c.fingerprint then
            fromCore (Workflow.step g s c)
          else if !e.handleActiveAtReplay then
            denied s "workflow_unavailable"
          else fromCore (Workflow.step g s c)
      | none =>
          if s.current.revision != c.expectedRevision then
            fromCore (Workflow.step g s c)
          else if !e.installed then denied s "workflow_unavailable"
          else if (edgeFor g s.current.state c.action).isNone then
            fromCore (Workflow.step g s c)
          else if e.postEdgeError != "" then denied s e.postEdgeError
          else if !e.activeBeforeWrite then denied s "workflow_unavailable"
          else
            let candidate := Workflow.step g s { c with guard := true }
            match candidate.outcome with
            | .committed _ =>
                if e.activeAfterWrite then fromCore candidate
                else denied s "workflow_unavailable"
            | _ => fromCore candidate

theorem preflight_denial_unchanged (g : Graph) (s : Store) (c : Command)
    (e : Environment) (code : String)
    (denial : preflightError e = some code) :
    step g s c e = denied s code := by
  simp [step, denial]

theorem denied_replay_unchanged (g : Graph) (s : Store) (c : Command)
    (e : Environment) (code : String) (prior : Receipt)
    (denial : preflightError e = some code)
    (_found : receiptFor s c.requestId = some prior) :
    (step g s c e).store = s := by
  rw [preflight_denial_unchanged g s c e code denial]
  rfl

theorem fresh_guard_failure_unchanged (g : Graph) (s : Store) (c : Command)
    (e : Environment) (code : String)
    (admitted : preflightError e = none)
    (fresh : receiptFor s c.requestId = none)
    (revision : s.current.revision = c.expectedRevision)
    (installed : e.installed = true)
    (edge : (edgeFor g s.current.state c.action).isNone = false)
    (failure : e.postEdgeError = code)
    (nonempty : code ≠ "") :
    step g s c e = denied s code := by
  simp [step, admitted, fresh, revision, installed, edge, failure, nonempty]

theorem late_withdrawal_rolls_back (g : Graph) (s : Store) (c : Command)
    (e : Environment)
    (admitted : preflightError e = none)
    (fresh : receiptFor s c.requestId = none)
    (revision : s.current.revision = c.expectedRevision)
    (installed : e.installed = true)
    (edge : (edgeFor g s.current.state c.action).isNone = false)
    (guardPassed : e.postEdgeError = "")
    (activeBefore : e.activeBeforeWrite = true)
    (candidate : ∃ after,
      (Workflow.step g s { c with guard := true }).outcome = .committed after)
    (withdrawn : e.activeAfterWrite = false) :
    step g s c e = denied s "workflow_unavailable" := by
  obtain ⟨after, committed⟩ := candidate
  simp [step, admitted, fresh, revision, installed, edge,
    guardPassed, activeBefore, committed, withdrawn]

theorem committed_requires_admission (g : Graph) (s : Store) (c : Command)
    (e : Environment) (successful : (step g s c e).committed = true) :
    preflightError e = none ∧
    receiptFor s c.requestId = none ∧
    e.postEdgeError = "" ∧
    e.activeBeforeWrite = true ∧
    e.activeAfterWrite = true ∧
    ∃ after, (Workflow.step g s { c with guard := true }).outcome = .committed after ∧
      (step g s c e).store = (Workflow.step g s { c with guard := true }).store := by
  have admitted : preflightError e = none := by
    cases h : preflightError e with
    | none => rfl
    | some code => simp [step, h, denied] at successful
  have fresh : receiptFor s c.requestId = none := by
    cases h : receiptFor s c.requestId with
    | none => rfl
    | some prior =>
        have noCore : (fromCore (Workflow.step g s c)).committed ≠ true := by
          intro coreSuccess
          obtain ⟨after, coreCommit, _⟩ := fromCore_committed _ coreSuccess
          exact Workflow.existing_receipt_never_commits g s c prior h after coreCommit
        simp [step, admitted, h] at successful
        split at successful <;> simp_all
        split at successful <;> simp_all [denied]
  have revision : s.current.revision = c.expectedRevision := by
    by_cases hRev : s.current.revision = c.expectedRevision
    · exact hRev
    · have stale : (Workflow.step g s c).outcome = .revisionConflict := by
        have mismatch : (s.current.revision != c.expectedRevision) = true := by
          simp [hRev]
        rw [Workflow.stale_revision_rejected g s c fresh mismatch]
        rfl
      simp [step, admitted, fresh, hRev, stale, fromCore] at successful
  have installed : e.installed = true := by
    cases hInstalled : e.installed with
    | true => rfl
    | false => simp [step, admitted, fresh, revision, hInstalled, denied] at successful
  have edge : (edgeFor g s.current.state c.action).isNone = false := by
    cases hEdge : (edgeFor g s.current.state c.action).isNone with
    | false => rfl
    | true =>
        have invalid : (Workflow.step g s c).outcome = .invalidTransition := by
          cases hFound : edgeFor g s.current.state c.action with
          | none => simp [Workflow.step, fresh, revision, hFound, Workflow.reject]
          | some _ => simp [hFound] at hEdge
        simp [step, admitted, fresh, revision, installed, hEdge,
          invalid, fromCore] at successful
  have guardPassed : e.postEdgeError = "" := by
    by_cases hGuard : e.postEdgeError = ""
    · exact hGuard
    · simp [step, admitted, fresh, revision, installed, edge,
        hGuard, denied] at successful
  have activeBefore : e.activeBeforeWrite = true := by
    cases hActive : e.activeBeforeWrite with
    | true => rfl
    | false => simp [step, admitted, fresh, revision, installed, edge,
        guardPassed, hActive, denied] at successful
  have activeAfter : e.activeAfterWrite = true := by
    cases hActive : e.activeAfterWrite with
    | true => rfl
    | false =>
        simp [step, admitted, fresh, revision, installed, edge,
          guardPassed, activeBefore, hActive] at successful
        split at successful <;> simp_all [fromCore, denied]
  refine ⟨admitted, fresh, guardPassed, activeBefore, activeAfter, ?_⟩
  cases hCore : (Workflow.step g s { c with guard := true }).outcome with
  | committed after =>
      refine ⟨after, rfl, ?_⟩
      simp [step, admitted, fresh, revision, installed, edge,
        guardPassed, activeBefore, activeAfter, hCore, fromCore]
  | replayed _ =>
      simp [step, admitted, fresh, revision, installed, edge,
        guardPassed, activeBefore, hCore, fromCore] at successful
  | revisionConflict =>
      simp [step, admitted, fresh, revision, installed, edge,
        guardPassed, activeBefore, hCore, fromCore] at successful
  | requestConflict =>
      simp [step, admitted, fresh, revision, installed, edge,
        guardPassed, activeBefore, hCore, fromCore] at successful
  | invalidTransition =>
      simp [step, admitted, fresh, revision, installed, edge,
        guardPassed, activeBefore, hCore, fromCore] at successful
  | guardRejected =>
      simp [step, admitted, fresh, revision, installed, edge,
        guardPassed, activeBefore, hCore, fromCore] at successful

end Merv.Admission
