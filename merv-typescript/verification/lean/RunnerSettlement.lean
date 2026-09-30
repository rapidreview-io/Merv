import Std

/-! Runner settlement with an ABSTRACT workspace driver and receipt transport. No Code
implementation, Git semantics, server idempotence, or remote exactly-once theorem.
A crash after a remote effect but before its local marker repeats the invocation.
A completed local marker prevents subsequent calls for that debt. -/
namespace Merv.RunnerSettlement
inductive Answer where
  | retry | crash | complete
  deriving Repr, DecidableEq, Inhabited
structure Debt where
  done : Bool := false
  calls : Nat := 0
  deriving Repr, DecidableEq, Inhabited

def attempt (d : Debt) (a : Answer) : Debt :=
  if d.done then d else { done := decide (a = .complete), calls := d.calls + 1 }

structure State where
  terminal : Bool := true
  driver : Bool := true
  workspace : Bool := true
  /-- Durable completion markers; counters below are ghost observations. -/
  release : Debt := {}
  receipt : Debt := {}
  result : Debt := {}
  captured : Bool := false
  closed : Bool := false
  settled : Bool := false
  captures : Nat := 0
  closes : Nat := 0
  deriving Repr, DecidableEq, Inhabited

structure Tick where
  release : Answer := .complete
  capture : Bool := true
  receipt : Answer := .complete
  result : Answer := .complete
  close : Bool := true
  deriving Repr, Inhabited

/-- Only close after capture, receipt acknowledgement and result marker. -/
def closeStage (s : State) (t : Tick) : State :=
  let s := { s with result := attempt s.result t.result }
  if s.result.done then
    { s with closes := s.closes + 1, closed := t.close, settled := t.close }
  else s

def receiptStage (s : State) (t : Tick) : State :=
  let s := { s with receipt := attempt s.receipt t.receipt }
  if s.receipt.done then closeStage s t else s

def captureStage (s : State) (t : Tick) : State :=
  let s := { s with captures := s.captures + 1 }
  if t.capture then receiptStage { s with captured := true } t else s

def tick (s : State) (t : Tick) : State :=
  if s.settled || !s.terminal then s else
  let s := { s with release := attempt s.release t.release }
  if !s.release.done || !s.driver then s else
  if !s.workspace || s.closed then { s with settled := true }
  else captureStage s t

inductive Command where
  | poll (t : Tick)
  | driver (present : Bool)
  | terminate (terminationWitness : Bool)
  | restart
  deriving Repr, Inhabited

def step (s : State) : Command → State
  | .poll t => tick s t
  | .driver present => { s with driver := present }
  | .terminate evidence => { s with terminal := s.terminal || evidence }
  | .restart => s

def run : State → List Command → State
  | s, [] => s
  | s, c :: cs => run (step s c) cs

theorem completion_marker_blocks_attempt (d : Debt) (a : Answer) (h : d.done = true) :
    attempt d a = d := by simp [attempt, h]

/-- A concrete refutation of exactly-once invocation across the crash window. -/
theorem crash_window_repeats_call :
    (attempt (attempt {} .crash) .complete).calls = 2 ∧
    (attempt (attempt {} .crash) .complete).done = true := by decide

private theorem close_release (s : State) (t : Tick) : (closeStage s t).release = s.release := by
  simp [closeStage]; split <;> rfl
private theorem receipt_release (s : State) (t : Tick) : (receiptStage s t).release = s.release := by
  simp only [receiptStage]; split <;> simp [close_release]
private theorem capture_release (s : State) (t : Tick) : (captureStage s t).release = s.release := by
  simp only [captureStage]; split <;> simp [receipt_release]

private theorem close_receipt (s : State) (t : Tick) : (closeStage s t).receipt = s.receipt := by
  simp [closeStage]; split <;> rfl

theorem step_completed_release (s : State) (c : Command) (h : s.release.done = true) :
    (step s c).release = s.release := by
  cases c <;> simp only [step, tick]
  split
  · rfl
  · simp only [completion_marker_blocks_attempt s.release _ h]
    split
    · rfl
    · split
      · rfl
      · exact capture_release _ _

theorem step_completed_receipt (s : State) (c : Command) (h : s.receipt.done = true) :
    (step s c).receipt = s.receipt := by
  cases c <;> simp only [step, tick, captureStage, receiptStage]
  all_goals (repeat' split) <;> simp_all [completion_marker_blocks_attempt, close_receipt]

theorem step_completed_result (s : State) (c : Command) (h : s.result.done = true) :
    (step s c).result = s.result := by
  cases c <;> simp only [step, tick, captureStage, receiptStage, closeStage]
  all_goals (repeat' split) <;> simp_all [completion_marker_blocks_attempt]

theorem arbitrary_trace_completed_debts (s : State) (cs : List Command) :
    (s.release.done = true → (run s cs).release = s.release) ∧
    (s.receipt.done = true → (run s cs).receipt = s.receipt) ∧
    (s.result.done = true → (run s cs).result = s.result) := by
  induction cs generalizing s with
  | nil => simp [run]
  | cons c cs ih =>
    refine ⟨?_, ?_, ?_⟩
    · intro h
      have e := step_completed_release s c h
      simpa [run, e] using (ih (step s c)).1 (by simpa [e] using h)
    · intro h
      have e := step_completed_receipt s c h
      simpa [run, e] using (ih (step s c)).2.1 (by simpa [e] using h)
    · intro h
      have e := step_completed_result s c h
      simpa [run, e] using (ih (step s c)).2.2 (by simpa [e] using h)

def Safe (s : State) : Prop :=
  (s.closed = true → s.captured = true ∧ s.release.done = true ∧
    s.receipt.done = true ∧ s.result.done = true) ∧
  (s.settled = true → s.terminal = true ∧ s.release.done = true ∧
    (s.workspace = true → s.closed = true))

theorem initial_safe : Safe ({} : State) := by simp [Safe]

theorem step_safe (s : State) (c : Command) (h : Safe s) : Safe (step s c) := by
  rcases h with ⟨hc, hs⟩
  cases c <;> simp only [step, tick, captureStage, receiptStage, closeStage, attempt]
  all_goals (repeat' split) <;> simp_all [Safe]
  all_goals intro h; simp_all

theorem arbitrary_trace_settlement_safe (s : State) (cs : List Command) (h : Safe s) :
    Safe (run s cs) := by
  induction cs generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (step_safe s c h)

theorem uncertain_cannot_settle (s : State) (t : Tick) (h : s.terminal = false) :
    tick s t = s := by simp [tick, h]
end Merv.RunnerSettlement
