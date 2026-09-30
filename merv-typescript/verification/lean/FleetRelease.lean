import Std

/-! One durable allocation, initially holding one reservation. Create commands are recorded
before they are sent. The scheduler may delay *any* send, provider effect, or reply arbitrarily;
`clock` may jump forwards or backwards. Retries keep the original key and profile.

External provider contracts, encoded as transition rules rather than claimed as Lean proofs
about a network service: a key identifies at most one machine; stopped/deleted keys remain
permanent tombstones; create and renew cannot revive them; a no-effect refusal really had no
effect; terminal observations truthfully describe that same key. `stopped` includes deleted
machines whose dedup entry persists. There is no TTL, deadline or fairness assumption.

`queued` and `inFlight` count actual same-key commands; `created`/`refused` count completed
provider operations, independently of reply delivery. Cancellation cannot retract a recorded
command. Terminal observation and reservation release are separate transitions. This per-key
physical invariant complements Fleet's global/project ledger count theorem; integration with
real controllers and the provider remains an external refinement obligation. -/
namespace Merv.FleetRelease

inductive Provider where
  | absent | live | stopped
  deriving Repr, BEq, DecidableEq, Inhabited

structure State where
  key : Nat := 1
  profile : Nat := 1
  originalLease : Nat := 3600000
  held : Bool := true
  cancelled : Bool := false
  attempts : Nat := 0
  queued : Nat := 0
  inFlight : Nat := 0
  created : Nat := 0
  refused : Nat := 0
  provider : Provider := .absent
  knownHandle : Bool := false
  terminalSeen : Bool := false
  noEffectSeen : Bool := false
  pendingStops : Nat := 0
  pendingRenews : Nat := 0
  now : Nat := 0
  observedExpiry : Nat := 0
  providerExpiry : Nat := 0
  deriving Repr, BEq, DecidableEq, Inhabited

inductive Command where
  | queueCreate (key profile : Nat) (connected : Bool)
  | sendCreate
  | createEffect
  | refuseEffect
  | receiveHandle
  | receiveRefusal
  | lostReply
  | cancel
  | queueStop
  | stopEffect
  | queueRenew
  | renewEffect
  | providerTerminal
  | observeTerminal
  | release
  | clock (now : Nat)
  | observeExpiry (expires : Nat)
  | restart (replacementProfile replacementLease : Nat)
  deriving Repr, BEq, DecidableEq, Inhabited

/-- Provider expiry describes the actual effect time, not when the controller recorded it. -/
def createExpiry (s : State) : Nat :=
  if s.provider = .absent then s.now + s.originalLease else s.providerExpiry

def renewExpiry (s : State) : Nat :=
  if s.provider = .live then max s.providerExpiry (s.now + s.originalLease) else s.providerExpiry

def step (s : State) : Command → State
  | .queueCreate key profile connected =>
    if s.held = true ∧ s.noEffectSeen = false ∧ connected = true ∧
        key = s.key ∧ profile = s.profile ∧
        (s.cancelled = false ∨ (s.attempts > 0 ∧ s.knownHandle = false)) then
      { s with attempts := s.attempts + 1, queued := s.queued + 1 } else s
  | .sendCreate =>
    if s.queued > 0 then { s with queued := s.queued - 1, inFlight := s.inFlight + 1 } else s
  | .createEffect =>
    if s.inFlight > 0 then
      { s with inFlight := s.inFlight - 1, created := s.created + 1, providerExpiry := createExpiry s,
               provider := if s.provider = .stopped then .stopped else .live } else s
  | .refuseEffect =>
    if s.inFlight > 0 then
      { s with inFlight := s.inFlight - 1, refused := s.refused + 1 } else s
  | .receiveHandle => if s.created > 0 then { s with knownHandle := true } else s
  | .receiveRefusal =>
    if s.refused > 0 ∧ s.attempts = 1 then
      { s with noEffectSeen := true, cancelled := true } else s
  | .lostReply => s
  | .cancel => { s with cancelled := true }
  | .queueStop =>
    if s.held = true ∧ s.knownHandle = true ∧ s.cancelled = true then
      { s with pendingStops := s.pendingStops + 1 } else s
  | .stopEffect =>
    if s.pendingStops > 0 then
      { s with pendingStops := s.pendingStops - 1,
               provider := if s.provider = .live then .stopped else s.provider } else s
  | .queueRenew =>
    if s.held = true ∧ s.knownHandle = true ∧ s.cancelled = false then
      { s with pendingRenews := s.pendingRenews + 1 } else s
  | .renewEffect =>
    if s.pendingRenews > 0 then
      { s with pendingRenews := s.pendingRenews - 1, providerExpiry := renewExpiry s } else s
  | .providerTerminal =>
    if s.provider = .live then { s with provider := .stopped } else s
  | .observeTerminal =>
    if s.knownHandle = true ∧ s.provider = .stopped then { s with terminalSeen := true } else s
  | .release =>
    if s.terminalSeen = true ∨
        (s.cancelled = true ∧ (s.attempts = 0 ∨ s.noEffectSeen = true)) then
      { s with held := false } else s
  | .clock now => { s with now := now }
  | .observeExpiry expires => { s with observedExpiry := max s.observedExpiry expires }
  | .restart _ _ => s

def trace (s : State) (cs : List Command) : State := cs.foldl step s

/-- Strong enough to cover an absent provider with a delayed, still-dangerous create. -/
structure Safe (s : State) : Prop where
  accounting : s.attempts = s.queued + s.inFlight + s.created + s.refused
  materialized : s.provider ≠ .absent ↔ s.created > 0
  terminal : s.terminalSeen = true → s.provider = .stopped
  refusal : s.noEffectSeen = true → s.attempts = 1 ∧ s.refused = 1
  protection : s.held = false →
    s.provider = .stopped ∨ (s.provider = .absent ∧ s.queued = 0 ∧ s.inFlight = 0)

theorem initial_identity_safe (key profile lease : Nat) :
    Safe { key := key, profile := profile, originalLease := lease } := by
  constructor <;> simp

theorem initial_safe : Safe ({} : State) := by
  constructor <;> simp

/-- Counted dispatches exclude a delayed second command before accepting a sole refusal. -/
theorem sole_refusal_no_pending (s : State) (h : Safe s)
    (one : s.attempts = 1) (refused : s.refused > 0) :
    s.queued = 0 ∧ s.inFlight = 0 ∧ s.created = 0 ∧ s.provider = .absent := by
  have ha := h.accounting
  have hc : s.created = 0 := by omega
  have hp : s.provider = .absent := by
    by_cases hp : s.provider = .absent
    · exact hp
    · have := h.materialized.mp hp
      omega
  exact ⟨by omega, by omega, hc, hp⟩

theorem step_safe (s : State) (c : Command) (h : Safe s) : Safe (step s c) := by
  have unchanged := h
  rcases h with ⟨accounting, materialized, terminal, refusal, protection⟩
  cases c <;> simp only [step]
  all_goals try split
  all_goals try split
  all_goals first | exact unchanged | apply Safe.mk
  all_goals try simp_all
  all_goals try intros
  all_goals try simp_all
  all_goals try omega
  all_goals cases hp : s.provider <;> try simp_all
  all_goals try intros
  all_goals try simp_all
  all_goals try omega

  all_goals cases hb : s.held <;> cases hr : s.noEffectSeen <;> try simp_all <;> omega


theorem trace_safe (s : State) (cs : List Command) (h : Safe s) : Safe (trace s cs) := by
  induction cs generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (step_safe s c h)

/-- The reason for local release persists across every later command. -/
def HasReleaseEvidence (s : State) : Prop :=
  s.held = false → s.terminalSeen = true ∨ s.attempts = 0 ∨ s.noEffectSeen = true

theorem step_release_evidence (s : State) (c : Command) (h : HasReleaseEvidence s) :
    HasReleaseEvidence (step s c) := by
  cases c <;> simp only [step]
  all_goals try split
  all_goals try split
  all_goals simp_all [HasReleaseEvidence]
  rename_i gate
  rcases gate with ht | ⟨_, ha⟩
  · exact .inl ht
  · exact .inr ha

theorem trace_release_evidence (s : State) (cs : List Command) (h : HasReleaseEvidence s) :
    HasReleaseEvidence (trace s cs) := by
  induction cs generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (step_release_evidence s c h)

/-- If any create effect ever materialized, local release requires actual terminal observation.
Neither cancellation, a truthful old expiry nor a different request's refusal can substitute. -/
theorem materialized_release_requires_terminal (cs : List Command)
    (materialized : (trace {} cs).created > 0) (released : (trace {} cs).held = false) :
    (trace {} cs).terminalSeen = true := by
  have safe := trace_safe {} cs initial_safe
  have evidence := trace_release_evidence {} cs (by simp [HasReleaseEvidence])
  rcases evidence released with terminal | none | refusal
  · exact terminal
  · have := safe.accounting; omega
  · have := safe.refusal refusal
    have := safe.accounting
    omega

theorem live_requires_hold (s : State) (h : Safe s) (live : s.provider = .live) :
    s.held = true := by
  cases hh : s.held with
  | true => rfl
  | false => have := h.protection hh; simp_all

/-- Physical safety for arbitrary finite traces, hence at every finite prefix of any run. -/
theorem arbitrary_trace_live_requires_reservation (cs : List Command)
    (live : (trace {} cs).provider = .live) : (trace {} cs).held = true :=
  live_requires_hold _ (trace_safe _ cs initial_safe) live

/-- Pending creates can be harmless after release only when a permanent tombstone fences them. -/
theorem released_pending_requires_tombstone (s : State) (h : Safe s)
    (released : s.held = false) (pending : s.queued + s.inFlight > 0) :
    s.provider = .stopped := by
  rcases h.protection released with tombstone | empty
  · exact tombstone
  · omega

theorem step_identity (s : State) (c : Command) :
    (step s c).key = s.key ∧ (step s c).profile = s.profile ∧
    (step s c).originalLease = s.originalLease := by
  cases c <;> simp only [step]
  all_goals repeat (first | split | exact ⟨rfl, rfl, rfl⟩ | trivial)

theorem trace_original_identity (s : State) (cs : List Command) :
    (trace s cs).key = s.key ∧ (trace s cs).profile = s.profile ∧
    (trace s cs).originalLease = s.originalLease := by
  induction cs generalizing s with
  | nil => exact ⟨rfl, rfl, rfl⟩
  | cons c cs ih =>
    obtain ⟨hk, hp, hl⟩ := ih (step s c)
    obtain ⟨sk, sp, sl⟩ := step_identity s c
    exact ⟨hk.trans sk, hp.trans sp, hl.trans sl⟩

theorem step_tombstone (s : State) (c : Command) (h : s.provider = .stopped) :
    (step s c).provider = .stopped := by
  cases c <;> simp only [step]
  all_goals repeat (first | split | exact h | rfl | simp_all)

theorem trace_tombstone_absorbing (s : State) (cs : List Command) (h : s.provider = .stopped) :
    (trace s cs).provider = .stopped := by
  induction cs generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (step_tombstone s c h)

theorem step_release_retained (s : State) (c : Command) (h : s.held = false) :
    (step s c).held = false := by
  cases c <;> simp only [step]
  all_goals repeat (first | split | exact h | rfl)

theorem trace_release_retained (s : State) (cs : List Command) (h : s.held = false) :
    (trace s cs).held = false := by
  induction cs generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (step_release_retained s c h)

/-- A physically stopped machine still holds capacity until local terminal evidence arrives. -/
theorem terminal_observation_then_release (s : State)
    (known : s.knownHandle = true) (stopped : s.provider = .stopped) :
    (step (step s .observeTerminal) .release).held = false := by
  simp [step, known, stopped]

theorem never_attempted_release (s : State) (cancelled : s.cancelled = true)
    (none : s.attempts = 0) : (step s .release).held = false := by
  simp [step, cancelled, none]

theorem sole_no_effect_refusal_releases (s : State) (one : s.attempts = 1)
    (refused : s.refused > 0) : (step (step s .receiveRefusal) .release).held = false := by
  simp [step, one, refused]

theorem concurrent_refusal_keeps_capacity (s : State) (many : s.attempts > 1)
    (noPrior : s.noEffectSeen = false) (noTerminal : s.terminalSeen = false) :
    (step (step s .receiveRefusal) .release).held = s.held := by
  have notOne : s.attempts ≠ 1 := by omega
  have notZero : s.attempts ≠ 0 := by omega
  simp [step, notOne, notZero, noPrior, noTerminal]

/-- Time and observations alone never supply any of the actual release witnesses. -/
theorem attempted_without_evidence_retains (s : State) (attempted : s.attempts > 0)
    (noTerminal : s.terminalSeen = false) (noRefusal : s.noEffectSeen = false) :
    (step s .release).held = s.held := by
  have hn : s.attempts ≠ 0 := by omega
  simp [step, hn, noTerminal, noRefusal]

theorem disconnected_cannot_queue (s : State) (key profile : Nat) :
    step s (.queueCreate key profile false) = s := by simp [step]

theorem wrong_identity_cannot_queue (s : State) (key profile : Nat) (connected : Bool)
    (wrong : key ≠ s.key ∨ profile ≠ s.profile) :
    step s (.queueCreate key profile connected) = s := by
  rcases wrong with h | h <;> simp [step, h]

/-- Queueing at the controller and sending to the provider are deliberately different steps. -/
def lateCreate (delay : Nat) : List Command :=
  [.queueCreate 1 1 true, .cancel, .clock delay, .restart 2 60000,
   .release, .sendCreate, .createEffect]

/-- The old timeout projection, included solely to exhibit the counterexample in the kernel. -/
def oldStep (s : State) (c : Command) : State :=
  match c with
  | .release =>
    if s.cancelled = true ∧ s.originalLease + 60000 ≤ s.now then { s with held := false }
    else step s c
  | _ => step s c

def oldTrace (s : State) (cs : List Command) := cs.foldl oldStep s

/-- Arbitrarily late effects after the old lease + allowance violate physical capacity safety. -/
theorem old_timeout_late_create_counterexample (delay : Nat) (late : 3660000 ≤ delay) :
    (oldTrace {} (lateCreate delay)).provider = .live ∧
    (oldTrace {} (lateCreate delay)).held = false := by
  simp [oldTrace, lateCreate, List.foldl, oldStep, step, late]

theorem fixed_rule_allows_late_effect_but_holds_reservation (delay : Nat) :
    (trace {} (lateCreate delay)).provider = .live ∧
    (trace {} (lateCreate delay)).held = true ∧
    (trace {} (lateCreate delay)).providerExpiry = delay + 3600000 := by
  simp [trace, lateCreate, List.foldl, step, createExpiry]

/-- Refusal of one request cannot retract an already recorded concurrent request. -/
theorem concurrent_first_refusal_trace :
    let result := trace {} [.queueCreate 1 1 true, .queueCreate 1 1 true,
      .sendCreate, .refuseEffect, .receiveRefusal, .cancel, .release,
      .clock 999999999999, .sendCreate, .createEffect]
    result.held = true ∧ result.provider = .live := by decide

/-- Unknown/lost handles can recover via the original identity even after cancellation/restart. -/
theorem same_key_recovery_after_lost_reply :
    let result := trace {} [.queueCreate 1 1 true, .sendCreate, .createEffect,
      .lostReply, .cancel, .restart 2 60000, .clock 999999999999,
      .queueCreate 2 2 true, .queueCreate 1 1 false, .queueCreate 1 1 true,
      .sendCreate, .createEffect, .receiveHandle, .queueStop, .stopEffect,
      .observeTerminal, .release]
    result.attempts = 2 ∧ result.provider = .stopped ∧ result.held = false ∧
    result.key = 1 ∧ result.profile = 1 ∧ result.originalLease = 3600000 := by decide

/-- A create that was queued before stop may execute after local release, but only deduplicates. -/
theorem delayed_create_after_terminal_is_tombstoned :
    let result := trace {} [.queueCreate 1 1 true, .sendCreate, .createEffect,
      .queueCreate 1 1 true, .receiveHandle, .cancel, .queueStop, .stopEffect,
      .observeTerminal, .release, .clock 999999999999, .sendCreate, .createEffect]
    result.held = false ∧ result.provider = .stopped ∧ result.created = 2 := by decide

/-- A pending renewal can extend a live machine long after cancellation; capacity remains held. -/
theorem delayed_renew_keeps_live_reservation :
    let result := trace {} [.queueCreate 1 1 true, .sendCreate, .createEffect,
      .receiveHandle, .queueRenew, .cancel, .restart 2 60000, .clock 999999999999,
      .observeExpiry 3600000, .release, .renewEffect]
    result.held = true ∧ result.provider = .live ∧
    result.providerExpiry = 1000003599999 := by decide

/-- A renewal sent before cancellation cannot revive the stopped key even after release. -/
theorem delayed_renew_after_terminal_cannot_revive :
    let result := trace {} [.queueCreate 1 1 true, .sendCreate, .createEffect,
      .receiveHandle, .queueRenew, .cancel, .queueStop, .stopEffect, .observeTerminal,
      .release, .clock 999999999999, .renewEffect]
    result.held = false ∧ result.provider = .stopped ∧ result.providerExpiry = 3600000 := by decide

end Merv.FleetRelease
