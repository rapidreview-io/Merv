import Std

/-! The local workflow retirement handshake. observeIdle is a read outside the writer;
claim and retire are serialized writer operations. No claim is silently cancelled by retire.
A terminal session still needs captured output and an acknowledgement or elapsed grace. -/
namespace Merv.FleetWorkflow

inductive Session where
  | absent | active | closed (capturePending acknowledged : Bool) (closedAt : Nat)
  deriving Repr, BEq, DecidableEq, Inhabited

structure State where
  epoch : Nat := 1
  stopped : Bool := false
  released : Bool := false
  session : Session := .absent
  observedIdle : Bool := false
  time : Nat := 0
  grace : Nat := 120000
  deriving Repr, BEq, DecidableEq, Inhabited

def canRetire (s : State) : Bool :=
  match s.session with
  | .absent => true
  | .active => false
  | .closed capture ack closedAt => !capture && (ack || decide (closedAt + s.grace ≤ s.time))

inductive Command where
  | observeIdle
  | claim (epoch : Nat)
  | close (capturePending acknowledged : Bool)
  | retain
  | acknowledge
  | retire
  | terminal
  | time (now : Nat)
  | restart
  deriving Repr, Inhabited

def step (s : State) : Command → State
  | .observeIdle => { s with observedIdle := canRetire s }
  | .claim epoch =>
    if epoch = s.epoch ∧ s.stopped = false ∧ s.released = false ∧ s.session = .absent then
      { s with session := .active } else s
  | .close capture ack =>
    if s.session = .active then { s with session := .closed capture ack s.time } else s
  | .retain => match s.session with
    | .closed _ ack closedAt => { s with session := .closed false ack closedAt }
    | _ => s
  | .acknowledge => match s.session with
    | .closed capture _ closedAt => { s with session := .closed capture true closedAt }
    | _ => s
  | .retire => if s.observedIdle && canRetire s then { s with stopped := true } else s
  | .terminal => if s.stopped then { s with released := true } else s
  | .time now => { s with time := max s.time now }
  | .restart => { s with observedIdle := false }

def trace (s : State) (cs : List Command) := cs.foldl step s

def Safe (s : State) : Prop := s.session = .active → s.stopped = false ∧ s.released = false

theorem step_safe (s : State) (c : Command) (h : Safe s) : Safe (step s c) := by
  cases c <;> simp only [step]
  all_goals repeat (first | split | simp_all [Safe, canRetire])
  all_goals first | exact h | (intro active; simp_all)

theorem trace_retirement_safe (s : State) (cs : List Command) (h : Safe s) :
    Safe (trace s cs) := by
  induction cs generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (step_safe s c h)

theorem claim_requires_epoch (s : State) (epoch : Nat) (wrong : epoch ≠ s.epoch) :
    step s (.claim epoch) = s := by simp [step, wrong]

theorem retirement_checks_capture (s : State) (ack : Bool) (closedAt : Nat)
    (capture : s.session = .closed true ack closedAt) : step s .retire = s := by
  simp [step, canRetire, capture]

/-- Named old implementation counterexample: an idle read, then a successful claim, then
an unconditional writer using that old result stops an active session. -/
def oldRetire (s : State) : State :=
  if s.observedIdle then { s with stopped := true } else s

def idleClaim : State := step (step {} .observeIdle) (.claim 1)

theorem idle_read_stop_counterexample : ¬ Safe (oldRetire idleClaim) := by simp [Safe, oldRetire, idleClaim, step, canRetire]

theorem idle_read_conditional_retirement : Safe (step idleClaim .retire) := by simp [Safe, idleClaim, step, canRetire]

end Merv.FleetWorkflow
