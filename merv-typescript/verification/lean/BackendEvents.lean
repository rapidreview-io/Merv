import Std
namespace Merv.BackendEvents

/-- The live State scope and schema writer lock; no proof fields. -/
structure Pending where
  ticket : Nat
  publisher : Bool
  wanted : Bool := false
  deriving Repr, DecidableEq

/-- Ordinary, possibly corrupt database fields. Counts have no uniqueness constraint.
`records` is the publisher's application change; `external` survives local rollback. -/
structure State where
  allocated : Nat := 0
  head : Nat := 0
  committed : Nat → Bool := fun _ => false
  interested : Nat → Bool := fun _ => false
  records : Nat → Bool := fun _ => false
  effects : Nat → Nat := fun _ => 0
  external : Nat → Nat := fun _ => 0
  cursor : Nat := 0
  baseline : Nat := 0
  registered : Bool := false
  active : Bool := false
  serial : Nat := 0
  pending : Option Pending := none
  attempts : Nat := 0
  retryAt : Nat := 0
  clock : Nat := 0

def expected (s : State) (i : Nat) : Nat :=
  if s.baseline < i ∧ i ≤ s.cursor ∧ s.committed i = true ∧ s.interested i = true then 1 else 0

def Safe (s : State) : Prop :=
  s.baseline ≤ s.cursor ∧ s.cursor ≤ s.head ∧ s.head ≤ s.allocated ∧
  (∀ i, s.committed i = true → 0 < i ∧ i ≤ s.head) ∧
  (∀ i, s.records i = s.committed i) ∧
  (∀ i, s.effects i = expected s i) ∧
  (s.registered = false → s.cursor = 0 ∧ s.baseline = 0)

/-- Atomic publisher commit. Rollback consumes the sequence number but not this step. -/
def publish (s : State) (wanted : Bool) : State :=
  if s.head < s.allocated then
    { s with head := s.allocated
             committed := fun i => if i = s.allocated then true else s.committed i
             interested := fun i => if i = s.allocated then wanted else s.interested i
             records := fun i => if i = s.allocated then true else s.records i
             pending := none }
  else { s with pending := none }

/-- One identity slot, including gaps. SQL's skip refines multiple steps. Counts
increment, so no-duplication is proved rather than forced by a unique effect key. -/
def advance (s : State) : State :=
  if s.cursor < s.head ∧ s.registered = true then
    { s with cursor := s.cursor + 1
             effects := fun i => s.effects i +
               if i = s.cursor + 1 ∧ s.committed i = true ∧ s.interested i = true then 1 else 0
             attempts := 0, retryAt := 0, pending := none }
  else { s with pending := none }

inductive Command where
  | beginPublish (wanted : Bool)
  | beginDelivery
  | commit (ticket : Nat)
  | abort (ticket : Nat)
  | failure (observedCursor : Nat)
  | subscribe (fromNow : Bool)
  | detach
  | crash
  | tick (elapsed : Nat)
  | notification
  deriving Repr

def step (s : State) (c : Command) : State :=
  match c with
  | .beginPublish wanted =>
    if s.pending.isNone then
      { s with allocated := s.allocated + 1, serial := s.serial + 1
               pending := some ⟨s.serial + 1, true, wanted⟩ }
    else s
  | .beginDelivery =>
    if s.pending.isNone ∧ s.registered = true ∧ s.active = true ∧
        s.retryAt ≤ s.clock ∧ s.cursor < s.head then
      { s with serial := s.serial + 1
               pending := some ⟨s.serial + 1, false, false⟩
               external := fun i => s.external i +
                 if i = s.cursor + 1 ∧ s.committed i = true ∧ s.interested i = true then 1 else 0 }
    else s
  | .commit ticket =>
    match s.pending with
    | none => s
    | some p => if p.ticket = ticket then
        if p.publisher then publish s p.wanted else advance s
      else s
  | .abort ticket =>
    match s.pending with
    | none => s
    | some p => if p.ticket = ticket then { s with pending := none } else s
  | .failure observed =>
    if s.pending.isNone ∧ s.cursor = observed then
      { s with attempts := s.attempts + 1
               retryAt := s.clock + 100 * 2 ^ min s.attempts 8 }
    else s
  | .subscribe fromNow =>
    if s.pending.isNone then
      if s.registered then { s with active := true }
      else { s with registered := true, active := true
                    cursor := if fromNow then s.head else s.cursor
                    baseline := if fromNow then s.head else s.baseline }
    else s
  | .detach => { s with active := false }
  | .crash => { s with active := false, pending := none }
  | .tick elapsed => { s with clock := s.clock + elapsed }
  | .notification => s

def run (s : State) (cs : List Command) : State := cs.foldl step s
set_option maxRecDepth 2048
set_option maxHeartbeats 800000

theorem initial_safe : Safe {} := by simp [Safe, expected]

theorem publish_safe (s : State) (wanted : Bool) (h : Safe s) : Safe (publish s wanted) := by
  rcases h with ⟨hb, hc, ha, hp, hr, he, hz⟩
  unfold publish
  split
  · rename_i hnew
    refine ⟨hb, by dsimp; omega, Nat.le_refl _, ?_, ?_, ?_, hz⟩
    · intro i hi
      simp only at hi ⊢
      split at hi
      · rename_i eq
        subst i
        omega
      · have := hp i hi
        omega
    · intro i
      simp only
      split <;> simp_all
    · intro i
      rw [he]
      unfold expected
      simp only
      by_cases eq : i = s.allocated
      · subst i
        have hn : ¬ s.allocated ≤ s.cursor := by omega
        simp [hn]
      · simp [eq]
  · exact ⟨hb, hc, ha, hp, hr, he, hz⟩

theorem advance_safe (s : State) (h : Safe s) : Safe (advance s) := by
  rcases h with ⟨hb, hc, ha, hp, hr, he, hz⟩
  unfold advance
  split
  · rename_i hadv
    refine ⟨by dsimp; omega, by dsimp; omega, ha, hp, hr, ?_, by simp_all⟩
    intro i
    simp only
    rw [he]
    unfold expected
    simp only
    by_cases eq : i = s.cursor + 1
    · subst i
      have hn : ¬ s.cursor + 1 ≤ s.cursor := by omega
      have hl : s.baseline < s.cursor + 1 := by omega
      simp [hn, hl]
    · have same : (i ≤ s.cursor + 1) = (i ≤ s.cursor) := by apply propext; omega
      simp [eq, same]
  · exact ⟨hb, hc, ha, hp, hr, he, hz⟩

/-- All commands preserve the invariant, including arbitrary crash schedules. -/
theorem step_safe (s : State) (c : Command) (h : Safe s) : Safe (step s c) := by
  cases c with
  | beginPublish wanted =>
    simp only [step]
    split
    · rcases h with ⟨hb, hc, ha, hp, hr, he, hz⟩
      exact ⟨hb, hc, by dsimp; omega, hp, hr, he, hz⟩
    · exact h
  | beginDelivery => simp only [step]; split <;> exact h
  | commit ticket =>
    simp only [step]
    split
    · exact h
    · split
      · split
        · exact publish_safe _ _ h
        · exact advance_safe _ h
      · exact h
  | abort ticket => simp only [step]; split; exact h; split <;> exact h
  | failure observed => simp only [step]; split <;> exact h
  | subscribe fromNow =>
    simp only [step]
    split
    · split
      · exact h
      · rename_i hn
        rcases h with ⟨hb, hc, ha, hp, hr, he, hz⟩
        have hf : s.registered = false := by simpa using hn
        have hz := hz hf
        cases fromNow with
        | false => exact ⟨hb, hc, ha, hp, hr, he, by simp⟩
        | true =>
          refine ⟨Nat.le_refl _, Nat.le_refl _, ha, hp, hr, ?_, by simp⟩
          intro i
          rw [he]
          simp only [expected]
          have hh : ¬ (s.head < i ∧ i ≤ s.head ∧ s.committed i = true ∧ s.interested i = true) := by omega
          have hz' : ¬ (s.baseline < i ∧ i ≤ s.cursor ∧ s.committed i = true ∧ s.interested i = true) := by omega
          simp [hh, hz']
    · exact h
  | detach => exact h
  | crash => exact h
  | tick elapsed => exact h
  | notification => exact h

/-- Arbitrary-length histories from arbitrary safe states, not bounded enumeration. -/
theorem trace_safe (s : State) (cs : List Command) (h : Safe s) : Safe (run s cs) := by
  induction cs generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (step_safe s c h)

theorem cursor_never_passes_committed_head (cs : List Command) :
    (run {} cs).cursor ≤ (run {} cs).head := (trace_safe _ cs initial_safe).2.1

theorem publisher_change_iff_event (cs : List Command) (i : Nat) :
    (run {} cs).records i = (run {} cs).committed i := (trace_safe _ cs initial_safe).2.2.2.2.1 i

/-- Complete processed prefix: no lost or duplicate durable effects. -/
theorem exactly_once_durable_prefix (cs : List Command) (i : Nat) :
    (run {} cs).effects i = expected (run {} cs) i := (trace_safe _ cs initial_safe).2.2.2.2.2.1 i

theorem no_duplicate_effect (cs : List Command) (i : Nat) : (run {} cs).effects i ≤ 1 := by
  rw [exactly_once_durable_prefix]
  unfold expected
  split <;> omega

theorem no_uncommitted_effect (cs : List Command) (i : Nat)
    (h : (run {} cs).committed i = false) : (run {} cs).effects i = 0 := by
  rw [exactly_once_durable_prefix]
  simp [expected, h]

theorem no_lost_processed_effect (cs : List Command) (i : Nat)
    (hb : (run {} cs).baseline < i) (hc : i ≤ (run {} cs).cursor)
    (hp : (run {} cs).committed i = true) (hw : (run {} cs).interested i = true) :
    (run {} cs).effects i = 1 := by
  rw [exactly_once_durable_prefix]
  simp [expected, hb, hc, hp, hw]

theorem stale_failure_is_inert (s : State) (observed : Nat) (h : observed < s.cursor) :
    step s (.failure observed) = s := by
  have hn : s.cursor ≠ observed := by omega
  simp [step, hn]

theorem stale_commit_is_inert (s : State) (p : Pending) (ticket : Nat)
    (hp : s.pending = some p) (ht : p.ticket ≠ ticket) : step s (.commit ticket) = s := by
  simp [step, hp, ht]

theorem crash_keeps_durable_data (s : State) :
    (step s .crash).effects = s.effects ∧ (step s .crash).cursor = s.cursor ∧
    (step s .crash).committed = s.committed ∧ (step s .crash).records = s.records := by simp [step]

theorem backoff_blocks_delivery (s : State) (h : s.clock < s.retryAt) :
    step s .beginDelivery = s := by
  have hn : ¬ s.retryAt ≤ s.clock := by omega
  simp [step, hn]

/-- Positive recovery after repair/backoff. Fair scheduling and handler termination
are assumptions; they are not consequences of the safety invariant. -/
theorem delivery_progress (s : State) (hn : s.pending = none)
    (hr : s.registered = true) (ha : s.active = true)
    (ht : s.retryAt ≤ s.clock) (hc : s.cursor < s.head) :
    let r := run s [.beginDelivery, .commit (s.serial + 1)]
    r.cursor = s.cursor + 1 ∧ r.attempts = 0 ∧ r.retryAt = 0 := by
  simp [run, step, advance, hn, hr, ha, ht, hc]

theorem admitted_commit_survives_detach (s : State) (p : Pending)
    (hp : s.pending = some p) :
    (step (step s .detach) (.commit p.ticket)).cursor = (step s (.commit p.ticket)).cursor ∧
    (step (step s .detach) (.commit p.ticket)).effects = (step s (.commit p.ticket)).effects := by
  simp only [step, hp]
  simp only [ite_true]
  cases p.publisher <;> simp only [Bool.false_eq_true, ↓reduceIte, publish, advance]
  all_goals split <;> exact ⟨rfl, rfl⟩

/-- A finite suffix of successful commits reaches the current head, including gaps. -/
def recover (s : State) : Nat → State
  | 0 => s
  | n + 1 => recover (advance s) n

theorem recover_reaches_head (s : State) (n : Nat) (h : s.head ≤ s.cursor + n)
    (hr : s.registered = true) : (recover s n).cursor ≥ s.head := by
  induction n generalizing s with
  | zero => simpa [recover] using h
  | succ n ih =>
    simp only [recover]
    by_cases hc : s.cursor < s.head
    · have ha : (advance s).head ≤ (advance s).cursor + n := by simp [advance, hc, hr]; omega
      simpa [advance, hc, hr] using ih (advance s) ha (by simp [advance, hc, hr])
    · have he : advance s = { s with pending := none } := by simp [advance, hc]
      have ha : (advance s).head ≤ (advance s).cursor + n := by simp [he]; omega
      simpa [he] using ih (advance s) ha (by simp [he, hr])

/-- Executable dispatcher pass; failure aborts effects before recording retry. -/
def pump (s : State) (fail : Bool) : Nat → State
  | 0 => s
  | n + 1 =>
    let admitted := step s .beginDelivery
    match admitted.pending with
    | none => admitted
    | some p =>
      if p.publisher then admitted else
      if fail && admitted.committed (admitted.cursor + 1) && admitted.interested (admitted.cursor + 1) then
        step (step admitted (.abort p.ticket)) (.failure admitted.cursor)
      else pump (step admitted (.commit p.ticket)) fail n

theorem pump_safe (s : State) (fail : Bool) (n : Nat) (h : Safe s) : Safe (pump s fail n) := by
  induction n generalizing s with
  | zero => exact h
  | succ n ih =>
    simp only [pump]
    have ha := step_safe s .beginDelivery h
    split
    · exact ha
    · split
      · exact ha
      · split
        · exact step_safe _ _ (step_safe _ _ ha)
        · exact ih _ (step_safe _ _ ha)

/-- A committed ticket cannot be replayed against its now-retired scope. -/
theorem commit_replay_inert (s : State) (ticket : Nat) :
    step (step s (.commit ticket)) (.commit ticket) = step s (.commit ticket) := by
  cases hp : s.pending with
  | none => simp [step, hp]
  | some p =>
    by_cases ht : p.ticket = ticket
    · have hn : (step s (.commit ticket)).pending = none := by
        simp only [step, hp, ht, ↓reduceIte]
        split <;> simp only [publish, advance] <;> split <;> rfl
      have unit : ∀ r : State, r.pending = none → step r (.commit ticket) = r := by
        intro r hr
        simp [step, hr]
      exact unit _ hn
    · have hi : step s (.commit ticket) = s := by simp [step, hp, ht]
      rw [hi, hi]

theorem crash_retires_scope (s : State) (ticket : Nat) :
    step (step s .crash) (.commit ticket) = step s .crash := by simp [step]

/-- A new publication can never arrive behind a consumer's cursor. This is the
commit-order property supplied by the real schema-wide writer lock. -/
theorem publication_above_cursor (s : State) (h : Safe s) (hn : s.head < s.allocated) :
    s.cursor < s.allocated := by
  have := h.2.1
  omega

theorem step_effects_monotone (s : State) (c : Command) (i : Nat) :
    s.effects i ≤ (step s c).effects i := by
  cases c <;> simp only [step]
  all_goals repeat' first | split | simp_all [publish, advance]

/-- Once an effect is durable, no suffix of failures, crashes, or replacements removes it. -/
theorem trace_effects_monotone (s : State) (cs : List Command) (i : Nat) :
    s.effects i ≤ (run s cs).effects i := by
  induction cs generalizing s with
  | nil => exact Nat.le_refl _
  | cons c cs ih => exact Nat.le_trans (step_effects_monotone s c i) (ih (step s c))

theorem recover_safe (s : State) (n : Nat) (h : Safe s) : Safe (recover s n) := by
  induction n generalizing s with
  | zero => exact h
  | succ n ih => exact ih _ (advance_safe s h)

theorem recover_head (s : State) (n : Nat) : (recover s n).head = s.head := by
  induction n generalizing s with
  | zero => rfl
  | succ n ih =>
    rw [recover, ih]
    unfold advance
    split <;> rfl

theorem recovery_completes_backlog (s : State) (n : Nat) (hs : Safe s)
    (hr : s.registered = true) (hn : s.head ≤ s.cursor + n) :
    (recover s n).cursor = s.head ∧ Safe (recover s n) := by
  have safe := recover_safe s n hs
  have bound := safe.2.1
  rw [recover_head] at bound
  have reached := recover_reaches_head s n hn hr
  exact ⟨by omega, safe⟩

def sample : State := run {} [.beginPublish true, .commit 1, .subscribe false]
/-- Deliberate mutants demonstrate the invariant is falsifiable. -/
def cursorOnly (s : State) : State := { s with cursor := s.cursor + 1 }
def effectOnly (s : State) : State := { s with effects := fun i => if i = 1 then s.effects i + 1 else s.effects i }
theorem cursor_only_counterexample : (cursorOnly sample).effects 1 ≠ expected (cursorOnly sample) 1 := by decide
theorem effect_only_counterexample : (effectOnly sample).effects 1 ≠ expected (effectOnly sample) 1 := by decide

def replayExample : State := run sample
  [.beginDelivery, .abort 2, .failure 0, .tick 100, .beginDelivery, .commit 3, .crash,
   .subscribe false, .beginDelivery, .commit 4]
theorem external_redelivery_counterexample :
    replayExample.external 1 = 2 ∧ replayExample.effects 1 = 1 ∧ replayExample.cursor = 1 := by decide

/-- Without commit-order serialization a lower ID can arrive behind the cursor. -/
def latePublication : State :=
  let s := run {} [.beginPublish false, .abort 1, .beginPublish false, .commit 2,
    .subscribe false, .beginDelivery, .commit 3, .beginDelivery, .commit 4]
  { s with committed := fun i => if i = 1 then true else s.committed i
           interested := fun i => if i = 1 then true else s.interested i }
theorem commit_order_counterexample : latePublication.effects 1 ≠ expected latePublication 1 := by decide
end Merv.BackendEvents
