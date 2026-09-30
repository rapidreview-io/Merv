import Std

/-! Persisted diagnostic lease facts for an allocation whose create was attempted.
No bound on controller pause, command delivery, provider effects, or replies is assumed.
Even a known expiry cannot prove a queued create/renew has finished. `terminal` represents
trusted terminal/deleted evidence for the pinned provider identity, not elapsed time.
Physical truth and permanent provider tombstones are external contracts, modeled separately
in FleetRelease. Never-attempted/sole no-effect refusal releases belong to Fleet/FleetRelease. -/
namespace Merv.FleetLease

structure State where
  originalLease : Option Nat := none
  observedExpiry : Nat := 0
  stoppedAt : Option Nat := none
  releaseBy : Option Nat := none
  released : Bool := false
  deriving Repr, BEq, DecidableEq, Inhabited

/-- Legacy deadlines are discarded, never promoted to termination evidence. -/
def refresh (s : State) : State := { s with releaseBy := none }

inductive Command where
  | observe (expires : Nat)
  | stop (now : Nat)
  | reap (now : Nat)
  | terminal
  | restart (replacementLease : Nat)
  deriving Repr, Inhabited, BEq, DecidableEq

def step (s : State) : Command → State
  | .observe expires => refresh { s with observedExpiry := max s.observedExpiry expires }
  | .stop now => refresh { s with stoppedAt := some (s.stoppedAt.getD now) }
  | .reap _ => refresh s
  | .terminal => refresh { s with released := true }
  | .restart _ => refresh s

def trace (s : State) (cs : List Command) := cs.foldl step s

/-- Compatibility name: conservative evidence now means there is no timeout deadline. -/
def Evidence (s : State) : Prop := s.releaseBy = none

theorem refresh_evidence (s : State) : Evidence (refresh s) := rfl

theorem step_evidence (s : State) (c : Command) : Evidence (step s c) := by
  cases c <;> rfl

theorem trace_conservative_evidence (s : State) (cs : List Command) (h : Evidence s) :
    Evidence (trace s cs) := by
  induction cs generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (step_evidence s c)

theorem step_clears_legacy_deadline (s : State) (c : Command) :
    (step s c).releaseBy = none := step_evidence s c

theorem step_original (s : State) (c : Command) :
    (step s c).originalLease = s.originalLease := by cases c <;> rfl

theorem trace_original_lease (s : State) (cs : List Command) :
    (trace s cs).originalLease = s.originalLease := by
  induction cs generalizing s with
  | nil => rfl
  | cons c cs ih => exact (ih _).trans (step_original s c)

theorem arbitrary_time_never_releases (s : State) (now : Nat) :
    (step s (.reap now)).released = s.released := rfl

/-- Kept for existing audits; the stronger theorem also covers known original leases. -/
theorem unknown_never_times_out (s : State) (now : Nat) (_unknown : s.originalLease = none) :
    (step s (.reap now)).released = s.released := arbitrary_time_never_releases s now

/-- Exact release characterization, including arbitrary clocks, expiry reports and restarts. -/
theorem trace_release_iff_terminal (s : State) (cs : List Command) :
    (trace s cs).released = true ↔ s.released = true ∨ .terminal ∈ cs := by
  induction cs generalizing s with
  | nil => simp [trace]
  | cons c cs ih =>
    change (trace (step s c) cs).released = true ↔ _
    rw [ih]
    cases c <;> simp [step, refresh]

theorem attempted_retained_without_terminal (s : State) (cs : List Command)
    (held : s.released = false) (noTerminal : .terminal ∉ cs) :
    (trace s cs).released = false := by
  cases hr : (trace s cs).released with
  | false => rfl
  | true => rcases (trace_release_iff_terminal s cs).mp hr with h | h <;> simp_all

theorem terminal_recovery (s : State) : (step s .terminal).released = true := rfl

theorem terminal_retention (s : State) (cs : List Command) (h : s.released = true) :
    (trace s cs).released = true := (trace_release_iff_terminal s cs).mpr (.inl h)

theorem observed_highwater (s : State) (cs : List Command) :
    s.observedExpiry ≤ (trace s cs).observedExpiry := by
  have one (s : State) (c : Command) : s.observedExpiry ≤ (step s c).observedExpiry := by
    cases c <;> simp only [step, refresh]
    all_goals first | exact Nat.le_refl _ | exact Nat.le_max_left _ _
  induction cs generalizing s with
  | nil => exact Nat.le_refl _
  | cons c cs ih => exact Nat.le_trans (one s c) (ih _)

theorem replacement_lease_counterexample :
    (step (step (step { originalLease := some 3600000 } (.stop 0)) (.restart 60000))
      (.reap 120000)).released = false := by decide

/-- A deadline already persisted by the old implementation cannot release capacity. -/
theorem stale_deadline_cannot_release (now deadline lease : Nat) :
    (step { originalLease := some lease, releaseBy := some deadline } (.reap now)).released = false ∧
    (step { originalLease := some lease, releaseBy := some deadline } (.reap now)).releaseBy = none :=
  ⟨rfl, rfl⟩

end Merv.FleetLease
