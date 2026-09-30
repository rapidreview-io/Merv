import Std

/-! The shared ModelRelay -> Fleet/Pi usage ledger boundary, per admitted request.
Reservations are estimates. This model proves conservation of the reservation
until usable usage or a definite no-take refusal arrives, not that token estimates
bound actual provider billing. SQL commit/rollback is an external atomicity premise.
Crashes and unknown replies retain the charge. A callback that never commits can
leave an over-reservation; this model makes no eventual-settlement claim. -/
namespace Merv.BackendRelay

structure State where
  requestId : Nat := 1
  reservation : Nat
  booked : Nat
  day : Nat
  sent : Bool := false
  observed : Bool := false
  settled : Bool := false
  callbacks : Nat := 0
  pending : Option Nat := none
  commits : Nat := 0
  usageForwarded : Bool := false
  deriving Repr, BEq, DecidableEq, Inhabited

inductive Command where
  | send
  | terminal (usage : Option (Nat × Nat))
  | refusedBeforeSend
  | upstreamRefused
  | commitCallback
  | settleRequest (requestId amount : Nat)
  | forwardUsage
  | crash
  | unknownReply
  deriving Repr, BEq, DecidableEq, Inhabited

def initial (amount day : Nat) (requestId : Nat := 1) : State :=
  { requestId := requestId, reservation := amount, booked := amount, day := day }

/-- The owner locks the request row, then commits its receipt and ledger delta atomically.
Duplicates and conflicts cannot change an already committed amount. -/
def commit (s : State) (amount : Nat) : State :=
  if s.settled then s
  else { s with booked := amount, pending := none, settled := true, commits := s.commits + 1 }

def step (s : State) : Command → State
  | .send => if !s.observed then { s with sent := true } else s
  | .terminal usage =>
    if s.sent && !s.observed then
      { s with
        observed := true
        pending := usage.map (fun pair => pair.1 + pair.2)
        callbacks := if usage.isSome then s.callbacks + 1 else s.callbacks }
    else s
  | .refusedBeforeSend =>
    if !s.sent && !s.observed then
      { s with observed := true, pending := some 0, callbacks := s.callbacks + 1 }
    else s
  | .upstreamRefused =>
    if s.sent && !s.observed then
      { s with observed := true, pending := some 0, callbacks := s.callbacks + 1 }
    else s
  | .commitCallback => match s.pending with
    | none => s
    | some amount => commit s amount
  | .settleRequest id amount => if id = s.requestId then commit s amount else s
  | .forwardUsage => if s.settled then { s with usageForwarded := true } else s
  | .crash => { s with pending := none, observed := true }
  | .unknownReply => s

def trace (s : State) (cs : List Command) : State := cs.foldl step s

def Safe (s : State) : Prop :=
  s.callbacks ≤ 1 ∧
  (s.callbacks > 0 → s.observed = true) ∧
  (s.pending.isSome = true → s.observed = true ∧ s.callbacks = 1) ∧
  (s.settled = false → s.booked = s.reservation)

theorem initial_safe (amount day : Nat) : Safe (initial amount day) := by
  simp [Safe, initial]

theorem step_safe (s : State) (c : Command) (h : Safe s) : Safe (step s c) := by
  cases c <;> simp only [step, commit]
  all_goals repeat (first | split | exact h)
  all_goals simp_all [Safe]
  all_goals try omega
  all_goals cases s.pending <;> simp_all

theorem trace_safe (s : State) (cs : List Command) (h : Safe s) : Safe (trace s cs) := by
  induction cs generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (step_safe s c h)

theorem arbitrary_trace_one_callback (amount day : Nat) (cs : List Command) :
    (trace (initial amount day) cs).callbacks ≤ 1 :=
  (trace_safe _ cs (initial_safe amount day)).1

theorem step_reservation (s : State) (c : Command) :
    (step s c).reservation = s.reservation := by
  cases c <;> simp only [step, commit]
  all_goals repeat (first | split | rfl)

theorem trace_reservation (s : State) (cs : List Command) :
    (trace s cs).reservation = s.reservation := by
  induction cs generalizing s with
  | nil => rfl
  | cons c cs ih => exact (ih (step s c)).trans (step_reservation s c)

theorem unsettled_retains_reservation (amount day : Nat) (cs : List Command)
    (unsettled : (trace (initial amount day) cs).settled = false) :
    (trace (initial amount day) cs).booked = amount :=
  ((trace_safe _ cs (initial_safe amount day)).2.2.2 unsettled).trans (trace_reservation _ cs)

theorem malformed_usage_retains_charge (amount day : Nat) :
    (trace (initial amount day) [.send, .terminal none, .commitCallback]).booked = amount := by
  simp [trace, initial, step]

theorem valid_usage_settles (amount day input output : Nat) :
    (trace (initial amount day) [.send, .terminal (some (input, output)),
      .commitCallback]).booked = input + output := by
  simp [trace, initial, step, commit]

theorem refusal_refunds (amount day : Nat) :
    (trace (initial amount day) [.send, .upstreamRefused, .commitCallback]).booked = 0 := by
  simp [trace, initial, step, commit]

theorem crash_before_callback_keeps_charge (amount day input output : Nat) :
    (trace (initial amount day) [.send, .terminal (some (input, output)),
      .crash, .commitCallback]).booked = amount := by
  simp [trace, initial, step]

theorem step_original_day (s : State) (c : Command) : (step s c).day = s.day := by
  cases c <;> simp only [step, commit]
  all_goals repeat (first | split | rfl)

theorem trace_original_day (s : State) (cs : List Command) : (trace s cs).day = s.day := by
  induction cs generalizing s with
  | nil => rfl
  | cons c cs ih => exact (ih (step s c)).trans (step_original_day s c)

/-- Coercing malformed/missing usage to zero manufactures a refund. -/
theorem zero_default_counterexample :
    (trace (initial 100 1) [.send, .terminal (some (0, 0)), .commitCallback]).booked ≠
    (trace (initial 100 1) [.send, .terminal none, .commitCallback]).booked := by decide

def Durable (s : State) : Prop :=
  s.commits ≤ 1 ∧ (s.settled = true ↔ s.commits = 1) ∧
  (s.usageForwarded = true → s.settled = true)

theorem initial_durable (amount day id : Nat) : Durable (initial amount day id) := by
  simp [Durable, initial]

theorem step_durable (s : State) (c : Command) (h : Durable s) : Durable (step s c) := by
  cases c <;> simp only [step, commit]
  all_goals repeat (first | split | exact h)
  all_goals simp_all [Durable]
  all_goals omega

theorem trace_durable (s : State) (cs : List Command) (h : Durable s) :
    Durable (trace s cs) := by
  induction cs generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (step_durable s c h)

theorem arbitrary_trace_at_most_one_commit (amount day id : Nat) (cs : List Command) :
    (trace (initial amount day id) cs).commits ≤ 1 :=
  (trace_durable _ cs (initial_durable amount day id)).1

theorem forwarded_usage_is_durable (amount day id : Nat) (cs : List Command)
    (h : (trace (initial amount day id) cs).usageForwarded = true) :
    (trace (initial amount day id) cs).settled = true :=
  (trace_durable _ cs (initial_durable amount day id)).2.2 h

theorem step_settled_stable (s : State) (c : Command) (h : s.settled = true) :
    (step s c).settled = true ∧ (step s c).booked = s.booked := by
  cases c <;> simp only [step, commit]
  all_goals repeat (first | split | simp_all)

theorem committed_amount_survives_arbitrary_retries (s : State) (cs : List Command)
    (h : s.settled = true) :
    (trace s cs).settled = true ∧ (trace s cs).booked = s.booked := by
  induction cs generalizing s with
  | nil => exact ⟨h, rfl⟩
  | cons c cs ih =>
    have next := step_settled_stable s c h
    have rest := ih (step s c) next.1
    exact ⟨rest.1, rest.2.trans next.2⟩

theorem wrong_request_cannot_settle (s : State) (id amount : Nat) (h : id ≠ s.requestId) :
    step s (.settleRequest id amount) = s := by simp [step, h]

theorem crash_after_commit_keeps_usage (amount day id input output : Nat) :
    (trace (initial amount day id) [.send, .terminal (some (input, output)),
      .commitCallback, .crash, .settleRequest id (input + output)]).booked = input + output := by
  simp [trace, initial, step, commit]

theorem crash_before_commit_cannot_forward_usage (amount day id input output : Nat) :
    (trace (initial amount day id) [.send, .terminal (some (input, output)),
      .crash, .commitCallback, .forwardUsage]).usageForwarded = false := by
  simp [trace, initial, step]

end Merv.BackendRelay
