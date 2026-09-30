import Std

/-! One retained Runner launch row and arbitrarily many guardian contenders. SQLite
atomicity/durability, authenticated IPC, hash collision resistance, boot identity and
OS group termination are explicit external assumptions. No eventual-launch claim.
Only approved controller/guardian transitions, never arbitrary SQL or ledger.end. -/
namespace Merv.RunnerOwnership
inductive Phase where
  | reserved | starting | running | stopping | exited | stopped | uncertain
  deriving Repr, BEq, DecidableEq, Inhabited

def Phase.terminal (p : Phase) : Bool := decide (p = .exited ∨ p = .stopped)

structure Durable where
  phase : Phase := .reserved
  /-- Historical abstraction of the irreversible claim, not an extra SQL column. -/
  claimed : Bool := false
  pinned : Option Nat := none
  deriving Repr, DecidableEq, Inhabited

structure State where
  row : Durable := {}
  guardian : Option Nat := none
  owner : Bool := false
  groupStarted : Bool := false
  observed : Phase := .starting
  shutdown : Bool := false
  naturalExit : Bool := false
  killWitness : Bool := false
  /-- Unbounded ghost counters; no safety bound is encoded in their type. -/
  claims : Nat := 0
  ownerSpawns : Nat := 0
  workerStarts : Nat := 0
  deriving Repr, DecidableEq, Inhabited

inductive Command where
  | claim (contender : Nat)
  | cancel
  | launch (contender command : Nat)
  | groupStart
  | running
  | shutdown (natural : Bool)
  | kill (liveChildSuccessfulGroupKill : Bool)
  | exit (sigkill : Bool)
  | lost (differentKnownBoot agedNoPin : Bool)
  | inspect
  | guardianCrash
  deriving Repr, Inhabited

def advance (s : State) : Command → State
  | .claim g => if s.row.phase = .reserved then
      { s with row := { s.row with phase := .starting, claimed := true }, guardian := some g, claims := s.claims + 1 } else s
  | .cancel => if s.row.phase = .reserved then
      { s with row := { s.row with phase := .stopped } } else s
  | .launch g h =>
      if s.guardian = some g ∧ s.row.phase = .starting ∧ s.row.pinned = none then
        { s with row := { s.row with pinned := some h }, owner := true, ownerSpawns := s.ownerSpawns + 1 } else s
  | .groupStart => if s.owner = true ∧ s.groupStarted = false then
      { s with groupStarted := true, workerStarts := s.workerStarts + 1 } else s
  | .running => if s.owner && s.row.phase != .stopping then
      { s with row := { s.row with phase := .running }, observed := .running } else s
  | .shutdown natural => if s.owner then
      { s with row := { s.row with phase := .stopping }, observed := .stopping, shutdown := true, naturalExit := natural } else s
  | .kill witness => if s.owner && s.shutdown && witness then
      { s with killWitness := true } else s
  | .exit sigkill => if s.owner then
      { s with row := { s.row with phase := if s.killWitness && s.shutdown && sigkill then (if s.naturalExit then .exited else .stopped) else .uncertain }, owner := false, guardian := none } else s
  | .lost boot aged =>
      if boot then { s with row := { s.row with phase := .stopped }, owner := false, guardian := none }
      else if aged ∧ s.row.pinned = none ∧
          (s.row.phase = .starting ∨ s.row.phase = .uncertain) then
        { s with row := { s.row with phase := .stopped }, guardian := none }
      else { s with row := { s.row with phase := .uncertain } }
  | .inspect => if s.row.phase = .uncertain ∧ s.guardian.isSome = true ∧
      (s.owner = true ∨ s.row.pinned = none) then
      { s with row := { s.row with phase := s.observed } } else s
  | .guardianCrash => { s with guardian := none }

/-- Controller early checks and SQLite immutable-terminal trigger. -/
def step (s : State) (c : Command) : State :=
  if s.row.phase.terminal then s else advance s c

def run : State → List Command → State
  | s, [] => s
  | s, c :: cs => run (step s c) cs

def Safe (s : State) : Prop :=
  s.claims ≤ 1 ∧ s.ownerSpawns ≤ s.claims ∧ s.workerStarts ≤ s.ownerSpawns ∧
  (s.row.claimed = false → s.claims = 0) ∧
  (s.row.phase = .reserved → s.row.claimed = false) ∧
  (s.row.pinned = none → s.ownerSpawns = 0) ∧
  (s.owner = true → s.row.pinned ≠ none ∧ s.ownerSpawns = 1) ∧
  (s.groupStarted = false → s.workerStarts = 0) ∧ s.observed ≠ .reserved ∧ (s.guardian.isSome = true → s.claims = 1)

theorem initial_safe : Safe ({} : State) := by simp [Safe]

theorem step_safe (s : State) (c : Command) (h : Safe s) : Safe (step s c) := by
  unfold step
  split
  · exact h
  · rcases h with ⟨h1, h2, h3, h4, h5, h6, h7, h8, h9, h10⟩
    cases c <;> simp only [advance] <;>
      (repeat' split) <;> simp_all [Safe] <;> omega

theorem arbitrary_trace_safe (cs : List Command) (s : State) (h : Safe s) :
    Safe (run s cs) := by
  induction cs generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih (step s c) (step_safe s c h)

theorem at_most_one_worker_start (cs : List Command) :
    (run {} cs).workerStarts ≤ 1 := by
  have h := arbitrary_trace_safe cs {} initial_safe
  rcases h with ⟨a, b, c, _⟩
  omega

theorem at_most_one_claim_and_owner (cs : List Command) :
    (run {} cs).claims ≤ 1 ∧ (run {} cs).ownerSpawns ≤ 1 := by
  have h := arbitrary_trace_safe cs {} initial_safe
  rcases h with ⟨a, b, _⟩
  omega

theorem pin_precedes_start (cs : List Command) :
    (run {} cs).workerStarts > 0 → (run {} cs).row.pinned ≠ none := by
  have h := arbitrary_trace_safe cs {} initial_safe
  rcases h with ⟨_, _, h3, _, _, h6, _⟩
  intro positive absent
  have := h6 absent
  omega

theorem terminal_preserved (s : State) (cs : List Command)
    (h : s.row.phase.terminal = true) : run s cs = s := by
  induction cs with
  | nil => rfl
  | cons c cs ih => simpa [run, step, h] using ih

theorem uncertain_cannot_claim (s : State) (g : Nat) (h : s.row.phase = .uncertain) :
    step s (.claim g) = s := by simp [step, advance, h, Phase.terminal]

theorem pinned_replay_no_effect (s : State) (g h : Nat) (p : s.row.pinned ≠ none) :
    step s (.launch g h) = s := by simp [step, advance, p]

theorem cancellation_wins (s : State) (h : s.row.phase = .reserved) (g : Nat) :
    step (step s .cancel) (.claim g) = step s .cancel := by
  simp [step, advance, h, Phase.terminal]

theorem claim_wins (s : State) (h : s.row.phase = .reserved) (g : Nat) :
    step (step s (.claim g)) .cancel = step s (.claim g) := by
  simp [step, advance, h, Phase.terminal]

theorem pinned_timeout_is_uncertain (s : State) (p : s.row.pinned ≠ none)
    (t : s.row.phase.terminal = false) :
    (step s (.lost false true)).row.phase = .uncertain := by
  simp [step, advance, p, t]

theorem unproven_exit_is_uncertain (s : State) (o : s.owner = true)
    (k : s.killWitness = false) (t : s.row.phase.terminal = false) (sig : Bool) :
    (step s (.exit sig)).row.phase = .uncertain := by
  simp [step, advance, o, k, t]

/-- Authenticated reply classification; hashes represent the command plus session token. -/
def launchReply (s : State) (g key : Nat) : String :=
  if s.guardian ≠ some g then "unavailable" else
  match s.row.pinned with
  | some previous => if previous = key then "ok" else "launch_conflict"
  | none => if s.row.phase = .starting then "ok" else "not_startable"

theorem exact_launch_replay (s : State) (g key : Nat)
    (owner : s.guardian = some g) (pin : s.row.pinned = some key) :
    launchReply s g key = "ok" ∧ step s (.launch g key) = s := by
  constructor
  · simp [launchReply, owner, pin]
  · apply pinned_replay_no_effect; simp [pin]

theorem conflicting_launch_replay (s : State) (g old key : Nat)
    (owner : s.guardian = some g) (pin : s.row.pinned = some old) (conflict : old ≠ key) :
    launchReply s g key = "launch_conflict" ∧ step s (.launch g key) = s := by
  constructor
  · simp [launchReply, owner, pin, conflict]
  · apply pinned_replay_no_effect; simp [pin]

theorem pin_precedes_owner_creation (cs : List Command) :
    (run {} cs).ownerSpawns > 0 → (run {} cs).row.pinned ≠ none := by
  have h := arbitrary_trace_safe cs {} initial_safe
  rcases h with ⟨_, _, _, _, _, absent, _⟩
  intro positive pin
  have := absent pin
  omega

theorem no_pin_timeout_has_no_worker (cs : List Command)
    (pin : (run {} cs).row.pinned = none) : (run {} cs).workerStarts = 0 := by
  have h := arbitrary_trace_safe cs {} initial_safe
  rcases h with ⟨_, _, starts, _, _, absent, _⟩
  have := absent pin
  omega


theorem step_pin_retained (s : State) (c : Command) (key : Nat)
    (h : s.row.pinned = some key) : (step s c).row.pinned = some key := by
  unfold step
  split
  · exact h
  · cases c <;> simp only [advance]
    all_goals (repeat' split) <;> simp_all

theorem arbitrary_trace_pin_retained (s : State) (cs : List Command) (key : Nat)
    (h : s.row.pinned = some key) : (run s cs).row.pinned = some key := by
  induction cs generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (step_pin_retained s c key h)

theorem guarded_no_pin_timeout (s : State) (pin : s.row.pinned = none)
    (phase : s.row.phase = .starting ∨ s.row.phase = .uncertain) :
    (step s (.lost false true)).row.phase = .stopped := by
  rcases phase with h | h <;> simp [step, advance, pin, h, Phase.terminal]

theorem known_different_boot_ends (s : State) (nonterminal : s.row.phase.terminal = false) :
    (step s (.lost true false)).row.phase = .stopped := by
  simp [step, advance, nonterminal]

end Merv.RunnerOwnership
