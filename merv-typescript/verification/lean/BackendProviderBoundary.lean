import FleetRelease

/-!
The pre-repair Sandboxes provider's registry is a different state machine from cloud
presence. This is a counterexample model of their composition, not a proof that
the old provider satisfies FleetRelease's permanent-terminal contract.

One operation key represents at most one machine here. Even with that favourable
assumption, a create admitted before cancellation may finish after a recover miss.
`pending` denotes possible future creates, not a timer or a lease. Unknown/crashed
calls remain pending. The original guarded variant states the abstract obligation. `Durable` below
models the implemented single-admission repair and independent queue generations.
-/
namespace Merv.BackendProviderBoundary

inductive Registry where
  | provisioning | deleting | stopped
  deriving Repr, BEq, DecidableEq, Inhabited

structure State where
  registry : Registry := .provisioning
  pending : Nat := 0
  live : Bool := false
  held : Bool := true
  deriving Repr, BEq, DecidableEq, Inhabited

inductive Command where
  | admitCreate
  | completeCreate
  | cancel
  | recoverMiss
  | deletePresent
  | observeAndRelease
  | delay
  deriving Repr, BEq, DecidableEq, Inhabited

/-- `guarded` requires the provider to persist and check outstanding effects in
the same admission/terminalization serialization domain. A process-local flag or
an expired queue lock cannot establish this predicate. -/
def step (guarded : Bool) (s : State) : Command → State
  | .admitCreate =>
    if s.registry = .provisioning then { s with pending := s.pending + 1 } else s
  | .completeCreate =>
    if s.pending > 0 then { s with pending := s.pending - 1, live := true } else s
  | .cancel =>
    if s.registry = .provisioning then { s with registry := .deleting } else s
  | .recoverMiss =>
    if s.registry = .deleting ∧ s.live = false ∧ (guarded = false ∨ s.pending = 0)
    then { s with registry := .stopped } else s
  | .deletePresent =>
    if s.registry = .deleting ∧ (guarded = false ∨ s.pending = 0)
    then { s with live := false, registry := .stopped } else s
  | .observeAndRelease =>
    if s.registry = .stopped then { s with held := false } else s
  | .delay => s

def trace (guarded : Bool) (s : State) (cs : List Command) : State :=
  cs.foldl (step guarded) s

def capacitySafe (s : State) : Prop := s.live = true → s.held = true

def TerminalSound (s : State) : Prop :=
  s.registry = .stopped → s.live = false ∧ s.pending = 0

def Safe (s : State) : Prop :=
  TerminalSound s ∧ (s.held = false → s.registry = .stopped)

def lateCreate : List Command :=
  [.admitCreate, .cancel, .recoverMiss, .observeAndRelease, .delay, .completeCreate]

/-- This is the pre-repair schedule retained by the real Python worker regression. -/
theorem current_provider_breaks_capacity :
    ¬ capacitySafe (trace false {} lateCreate) := by
  simp [capacitySafe, trace, lateCreate, step]

theorem current_provider_breaks_terminal_soundness :
    ¬ TerminalSound (trace false {} [.admitCreate, .cancel, .recoverMiss]) := by
  simp [TerminalSound, trace, step]

theorem initial_safe : Safe {} := by simp [Safe, TerminalSound]

theorem guarded_step_safe (s : State) (c : Command) (h : Safe s) :
    Safe (step true s c) := by
  rcases h with ⟨ht, hh⟩
  cases c <;> simp only [step]
  all_goals try split
  all_goals try exact ⟨ht, hh⟩
  all_goals simp_all [Safe, TerminalSound]
  all_goals try omega
  intro stopped
  have := (ht stopped).2
  omega

theorem guarded_trace_safe (s : State) (cs : List Command) (h : Safe s) :
    Safe (trace true s cs) := by
  induction cs generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (guarded_step_safe s c h)

theorem guarded_trace_capacity (cs : List Command) : capacitySafe (trace true {} cs) := by
  have h := guarded_trace_safe {} cs initial_safe
  intro live
  cases held : (trace true {} cs).held
  · have terminal := h.2 held
    have absent := (h.1 terminal).1
    simp_all
  · rfl

/-- Preserving safety need not prohibit ordinary cleanup after the admitted call
settles: delete the resulting machine, then return terminal evidence. -/
theorem guarded_cleanup_progress :
    trace true {} [.admitCreate, .cancel, .recoverMiss, .completeCreate,
      .deletePresent, .observeAndRelease] =
      { registry := .stopped, pending := 0, live := false, held := false } := by decide

theorem guarded_no_create_cleanup_progress :
    trace true {} [.cancel, .recoverMiss, .observeAndRelease] =
      { registry := .stopped, pending := 0, live := false, held := false } := by decide

/-- A truthful terminal response is the exact missing premise at the Fleet boundary. -/
theorem sound_terminal_release_is_safe (s : State) (h : TerminalSound s)
    (prior : capacitySafe s) :
    capacitySafe (step true s .observeAndRelease) := by
  simp only [step]
  split
  · rename_i stopped
    have absent := (h stopped).1
    simp [capacitySafe, absent]
  · exact prior

/-- Reuse the existing Fleet theorem only after connecting its abstract provider
state and reservation to the actual machine and ledger. -/
theorem fleet_refinement_transfers_capacity (s : State) (fleet : FleetRelease.State)
    (safe : FleetRelease.Safe fleet)
    (presence : s.live = true → fleet.provider = .live)
    (reservation : fleet.held = s.held) : capacitySafe s := by
  intro live
  rw [← reservation]
  exact FleetRelease.live_requires_hold fleet safe (presence live)

/-- The observed provider trace cannot be honestly represented by a safe Fleet
model while preserving both physical presence and reservation ownership. -/
theorem current_trace_has_no_safe_refinement (fleet : FleetRelease.State)
    (safe : FleetRelease.Safe fleet)
    (presence : (trace false {} lateCreate).live = true → fleet.provider = .live)
    (reservation : fleet.held = (trace false {} lateCreate).held) : False := by
  exact current_provider_breaks_capacity
    (fleet_refinement_transfers_capacity _ fleet safe presence reservation)


/-! Implemented repair: the database owns a *single* create admission. Queue
claims authorize admission and bookkeeping, but cannot revoke admitted effects.
`effect` and `settleSuccess` are separate: a process can crash between them.
Discovery never settles. `future`/`live` are physical ghost state, not facts the
registry can infer from a timeout. Successful return promises one native identity
and no later sibling; confirmed absence must be truthful for that identity.
-/
namespace Durable

inductive Phase where
  | notStarted | pending | settled
  deriving Repr, BEq, DecidableEq, Inhabited

inductive Status where
  | provisioning | ready | failed | deleting | stopped
  deriving Repr, BEq, DecidableEq, Inhabited

inductive WorkState where
  | queued | running | done | failed
  deriving Repr, BEq, DecidableEq, Inhabited

structure Claim where
  generation : Nat := 0
  state : WorkState := .queued
  deriving Repr, BEq, DecidableEq, Inhabited

inductive QueueCommand where
  | claim | reclaim | rearm
  | complete (generation : Nat)
  | retry (generation : Nat)
  | fail (generation : Nat)
  | heartbeat (generation : Nat)
  deriving Repr, BEq, DecidableEq, Inhabited

def owns (q : Claim) (g : Nat) : Prop := q.state = .running ∧ q.generation = g
instance (q : Claim) (g : Nat) : Decidable (owns q g) := inferInstanceAs (Decidable (_ ∧ _))

def queueStep (q : Claim) : QueueCommand → Claim
  | .claim => if q.state = .queued then
      { generation := q.generation + 1, state := .running } else q
  | .reclaim => if q.state = .running then { q with state := .queued } else q
  | .rearm => if q.state = .done ∨ q.state = .failed then { q with state := .queued } else q
  | .complete g => if owns q g then { q with state := .done } else q
  | .retry g => if owns q g then { q with state := .queued } else q
  | .fail g => if owns q g then { q with state := .failed } else q
  | .heartbeat _ => q -- only the timestamp changes in Python

theorem stale_callbacks_preserve_successor (q : Claim) (g : Nat) (h : q.generation ≠ g) :
    queueStep q (.complete g) = q ∧ queueStep q (.retry g) = q ∧
    queueStep q (.fail g) = q ∧ queueStep q (.heartbeat g) = q := by
  simp [queueStep, owns, h]

theorem generation_monotone (q : Claim) (c : QueueCommand) :
    q.generation ≤ (queueStep q c).generation := by
  cases c <;> simp only [queueStep]
  all_goals try split
  all_goals simp_all
  all_goals omega

theorem rearm_does_not_reuse_generation :
    (queueStep (queueStep (queueStep (queueStep {} .claim) (.complete 1)) .rearm)
      .claim).generation = 2 := by decide

structure State where
  status : Status := .provisioning
  phase : Phase := .notStarted
  claim : Claim := {}
  future : Bool := false
  live : Bool := false
  made : Bool := false
  known : Bool := false
  cleanupQueued : Bool := false
  held : Bool := true
  deriving Repr, BEq, DecidableEq, Inhabited

inductive Command where
  | queue (c : QueueCommand)
  | admit (generation : Nat)
  | effect
  | settleSuccess
  | definiteRefusal
  | failProvision (generation : Nat)
  | ready
  | cancel
  | recoverHit
  | recoverMiss
  | deleteAbsent
  | cleanupFailed
  | reportStopped
  | release
  | crashOrTimeout
  | deleteRetry
  deriving Repr, BEq, DecidableEq, Inhabited

def step (s : State) : Command → State
  | .queue c => { s with claim := queueStep s.claim c }
  | .admit g =>
    if s.status = .provisioning ∧ s.phase = .notStarted ∧ owns s.claim g then
      { s with phase := .pending, future := true } else s
  | .effect =>
    if s.phase = .pending ∧ s.future = true then
      { s with future := false, live := true, made := true } else s
  | .settleSuccess =>
    if s.phase = .pending ∧ s.made = true then
      { s with
        phase := .settled
        future := false
        known := true
        status := (if s.status = .failed then .deleting else s.status)
        cleanupQueued := s.cleanupQueued || s.status == .deleting || s.status == .failed }
    else s
  | .definiteRefusal =>
    if s.phase = .pending ∧ s.made = false then
      { s with
        phase := .settled
        future := false
        live := false
        status := (if s.status = .failed then .deleting else s.status)
        cleanupQueued := s.cleanupQueued || s.status == .deleting || s.status == .failed }
    else s
  | .failProvision g =>
    if s.status = .provisioning ∧ owns s.claim g then
      { s with status := .failed, claim := queueStep s.claim (.fail g) } else s
  | .ready =>
    if s.status = .provisioning ∧ s.phase = .settled ∧ s.known = true then
      { s with status := .ready } else s
  | .cancel =>
    if s.status ≠ .stopped then { s with status := .deleting, cleanupQueued := true } else s
  | .recoverHit => if s.live = true then { s with known := true } else s
  | .recoverMiss => s
  | .deleteAbsent =>
    if s.status = .deleting ∧ s.known = true then { s with live := false } else s
  | .cleanupFailed => { s with cleanupQueued := false }
  | .reportStopped =>
    if s.status = .deleting ∧ s.phase ≠ .pending ∧
        (s.known = false ∨ s.live = false) then
      { s with status := .stopped, cleanupQueued := false } else s
  | .release => if s.status = .stopped then { s with held := false } else s
  | .crashOrTimeout | .deleteRetry => s

def trace (s : State) (cs : List Command) := cs.foldl step s

def Safe (s : State) : Prop :=
  (s.future = true → s.phase = .pending) ∧
  (s.status = .stopped → s.live = false ∧ s.phase ≠ .pending) ∧
  (s.held = false → s.status = .stopped) ∧
  (s.known = false → s.phase ≠ .pending → s.live = false)

theorem initial_safe : Safe {} := by simp [Safe]

theorem step_safe (s : State) (c : Command) (h : Safe s) : Safe (step s c) := by
  rcases h with ⟨hf, ht, hh, hk⟩
  cases c <;> simp only [step]
  all_goals try split
  all_goals simp_all [Safe]
  all_goals grind

theorem trace_safe (s : State) (cs : List Command) (h : Safe s) : Safe (trace s cs) := by
  induction cs generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (step_safe s c h)

/-- Terminal evidence excludes both a present machine and a possible late effect. -/
theorem terminal_sound (cs : List Command) (stopped : (trace {} cs).status = .stopped) :
    (trace {} cs).live = false ∧ (trace {} cs).future = false := by
  have h := trace_safe {} cs initial_safe
  refine ⟨(h.2.1 stopped).1, ?_⟩
  cases future : (trace {} cs).future
  · rfl
  · exact False.elim ((h.2.1 stopped).2 (h.1 future))

theorem capacity_safe (cs : List Command) :
    (trace {} cs).live = true → (trace {} cs).held = true := by
  have h := trace_safe {} cs initial_safe
  intro live
  cases held : (trace {} cs).held
  · have absent := (h.2.1 (h.2.2.1 held)).1
    simp_all
  · rfl

/-- Phase never returns to notStarted, so an expired/rearmed queue claim cannot
admit a second provider call, even if a driver has no native idempotency token. -/
theorem admission_is_irreversible (s : State) (c : Command) (h : s.phase ≠ .notStarted) :
    (step s c).phase ≠ .notStarted := by
  cases c <;> simp only [step]
  all_goals try split
  all_goals simp_all

theorem stale_admission_is_noop (s : State) (g : Nat) (h : s.claim.generation ≠ g) :
    step s (.admit g) = s := by simp [step, owns, h]

theorem stale_failure_is_noop (s : State) (g : Nat) (h : s.claim.generation ≠ g) :
    step s (.failProvision g) = s := by simp [step, owns, h]

/-- The original race now withholds terminal evidence. -/
theorem late_create_retains_capacity :
    let s := trace {} [.queue .claim, .admit 1, .cancel, .recoverMiss,
      .reportStopped, .release, .effect]
    s.status = .deleting ∧ s.phase = .pending ∧ s.live = true ∧ s.held = true := by decide

/-- Stale completion cannot consume generation 2; late settlement still rearms
cleanup after its failure. Both fences are needed for this schedule. -/
theorem late_settlement_cleanup_progress :
    let s := trace {} [.queue .claim, .admit 1, .queue .reclaim, .queue .claim,
      .admit 2, .cancel, .recoverMiss, .reportStopped, .cleanupFailed,
      .effect, .settleSuccess, .queue (.complete 1), .deleteAbsent, .reportStopped, .release]
    s.status = .stopped ∧ s.phase = .settled ∧ s.live = false ∧ s.held = false ∧
      s.claim.generation = 2 ∧ s.claim.state = .running := by decide

theorem settlement_wakes_cleanup (s : State)
    (pending : s.phase = .pending) (made : s.made = true) (deleting : s.status = .deleting) :
    (step s .settleSuccess).cleanupQueued = true := by
  cases q : s.cleanupQueued <;> simp [step, pending, made, deleting, q] <;> decide

theorem crash_and_recovery_do_not_settle :
    let s := trace {} [.queue .claim, .admit 1, .effect, .crashOrTimeout,
      .queue .reclaim, .queue .claim, .recoverHit, .cancel, .deleteAbsent, .reportStopped]
    s.phase = .pending ∧ s.status = .deleting ∧ s.live = false ∧ s.held = true := by decide

theorem normal_progress :
    let s := trace {} [.queue .claim, .admit 1, .effect, .settleSuccess, .ready,
      .cancel, .deleteAbsent, .reportStopped, .release]
    s.status = .stopped ∧ s.held = false := by decide

theorem cancellation_before_admission :
    let s := trace {} [.queue .claim, .cancel, .reportStopped, .admit 1, .effect, .release]
    s.status = .stopped ∧ s.phase = .notStarted ∧ s.live = false ∧ s.held = false := by decide

theorem definite_refusal_progress :
    let s := trace {} [.queue .claim, .admit 1, .definiteRefusal, .failProvision 1,
      .cancel, .reportStopped, .release]
    s.status = .stopped ∧ s.held = false := by decide

/-- A provider timeout, lookup miss, or expired claim cannot reopen a terminal row. -/
theorem stopped_permanent (s : State) (c : Command) (h : Safe s)
    (stopped : s.status = .stopped) : (step s c).status = .stopped := by
  have hp := (h.2.1 stopped).2
  have absent := (h.2.1 stopped).1
  cases c <;> simp [step, stopped, hp, absent]

theorem admission_stays_closed (s : State) (cs : List Command)
    (h : s.phase ≠ .notStarted) : (trace s cs).phase ≠ .notStarted := by
  induction cs generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (admission_is_irreversible s c h)

/-- Worker deletion failures retry instead of permanently consuming a wakeup
which settlement delivered while the deletion claim was running. -/
theorem settlement_then_delete_failure_progress :
    let s := trace {} [.queue .claim, .admit 1, .cancel, .effect,
      .settleSuccess, .deleteRetry, .deleteAbsent, .reportStopped, .release]
    s.status = .stopped ∧ s.live = false ∧ s.held = false := by decide

end Durable

end Merv.BackendProviderBoundary
