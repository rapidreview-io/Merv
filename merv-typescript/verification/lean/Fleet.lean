import Std

/-! Local Fleet ledger. A command is one writer transaction, one remote dispatch, or one
reply, never a whole async advance. Remote facts are typed observations; no safety boolean
is supplied. Physical lease enforcement/idempotency are outside this local theorem. -/
namespace Merv.Fleet

structure Allocation where
  id : Nat
  project : Nat
  profile : Nat
  epoch : Nat
  lease : Nat
  deriving Repr, BEq, DecidableEq, Inhabited

inductive Effect where
  | create | launch | renew
  deriving Repr, BEq, DecidableEq, Inhabited

structure Flight where
  ticket : Nat
  allocation : Allocation
  effect : Effect
  deriving Repr, BEq, DecidableEq, Inhabited

structure Receipt where
  id : Nat
  machine : Nat
  launch : Nat := 0
  expires : Nat := 0
  deriving Repr, BEq, DecidableEq, Inhabited

structure Store where
  rows : List Allocation := []
  held : List Allocation := []
  stopped : List Nat := []
  drained : List Nat := []
  released : List Nat := []
  flights : List Flight := []
  settled : List Nat := []
  receipts : List Receipt := []
  uncertain : List Nat := []
  running : List Nat := []
  globalLimit : Nat := 1
  projectLimit : Nat → Nat := fun _ => 1
  deriving Inhabited

def projectCount (held : List Allocation) (p : Nat) : Nat :=
  (held.filter (fun a => a.project == p)).length

def row (s : Store) (id : Nat) := s.rows.find? (fun a => a.id == id)
def receipt (s : Store) (id : Nat) := s.receipts.find? (fun r => r.id == id)
def flight (s : Store) (ticket : Nat) := s.flights.find? (fun f => f.ticket == ticket)
def held (s : Store) (id : Nat) := s.held.any (fun a => a.id == id)
def attempts (s : Store) (id : Nat) :=
  (s.flights.filter (fun f => f.allocation.id == id && f.effect == .create)).length

def phase (s : Store) (id : Nat) : String :=
  if id ∈ s.released then "released"
  else if !held s id then "queued"
  else if id ∈ s.stopped then "releasing"
  else if id ∈ s.uncertain then "uncertain"
  else if id ∈ s.running then "running"
  else if ((receipt s id).map (·.launch)).getD 0 > 0 then "starting"
  else "provisioning"

def admits (s : Store) (id epoch profile : Nat) : Bool :=
  match row s id, receipt s id with
  | some a, some r => decide (a.epoch = epoch ∧ a.profile = profile ∧ r.launch > 0 ∧
      id ∉ s.stopped ∧ id ∉ s.drained ∧ id ∉ s.released ∧
      (phase s id = "starting" ∨ phase s id = "running"))
  | _, _ => false

/-- No insertion bypasses the actual counts. Configuration reductions retain existing holds. -/
def reserve (s : Store) (id : Nat) : Store :=
  match row s id with
  | none => s
  | some a =>
    if held s id || id ∈ s.released || id ∈ s.stopped then s
    else if s.held.length < s.globalLimit ∧ projectCount s.held a.project < s.projectLimit a.project
      then { s with held := a :: s.held } else s

def release (s : Store) (id : Nat) : Store :=
  { s with held := s.held.filter (fun a => a.id != id), released := id :: s.released }

inductive Reply where
  | ambiguous
  | refused
  | created (machine expires : Nat)
  | launched (machine launch expires : Nat)
  deriving Repr, Inhabited

/-- Replies can arrive after stop; observations never undo the stop or release tombstones. -/
def respond (s : Store) (ticket : Nat) (reply : Reply) : Store :=
  if ticket ∈ s.settled then s else
  match flight s ticket with
  | none => s
  | some f =>
    let id := f.allocation.id
    let next := { s with settled := ticket :: s.settled }
    if id ∈ s.released then next else
    match reply with
    | .ambiguous => { next with uncertain := id :: s.uncertain }
    | .refused =>
      if f.effect = .create ∧ attempts s id = 1 ∧ receipt s id = none
        then release { next with stopped := id :: s.stopped } id
        else { next with uncertain := id :: s.uncertain }
    | .created machine expires =>
      if f.effect = .create ∧ receipt s id = none then
        { next with receipts := ⟨id, machine, 0, expires⟩ :: s.receipts,
                    uncertain := s.uncertain.filter (· != id) }
      else next
    | .launched machine launch expires =>
      match receipt s id with
      | none => next
      | some r =>
        if f.effect = .launch ∧ r.machine = machine ∧ (r.launch = 0 ∨ r.launch = launch) then
          { next with receipts := ⟨id, machine, launch, expires⟩ :: s.receipts,
                      uncertain := s.uncertain.filter (· != id) }
        else next

inductive Command where
  | request (a : Allocation)
  | reserve (id : Nat)
  | dispatch (id ticket : Nat) (effect : Effect)
  | reply (ticket : Nat) (reply : Reply)
  | stop (id : Nat)
  | drain (id : Nat)
  | running (id : Nat)
  | terminal (id : Nat)
  | limits (globalLimit : Nat) (projectLimit : Nat → Nat)
  | restart
  deriving Inhabited

def step (s : Store) : Command → Store
  | .request a => if (row s a.id).isSome then s else { s with rows := a :: s.rows }
  | .reserve id => reserve s id
  | .dispatch id ticket effect =>
    match row s id with
    | none => s
    | some a =>
      if held s id && !(id ∈ s.released) && !(id ∈ s.stopped) &&
          !(flight s ticket).isSome then
        { s with flights := ⟨ticket, a, effect⟩ :: s.flights } else s
  | .reply ticket reply => respond s ticket reply
  | .stop id => { s with stopped := id :: s.stopped }
  | .drain id => { s with drained := id :: s.drained }
  | .running id => { s with running := id :: s.running }
  | .terminal id => release s id
  | .limits g p => { s with globalLimit := g, projectLimit := p }
  | .restart => s

def trace (s : Store) (cs : List Command) := cs.foldl step s

/-- Filtering held reservations cannot create capacity usage for any project. -/
theorem filter_project_le (xs : List Allocation) (f : Allocation → Bool) (p : Nat) :
    projectCount (xs.filter f) p ≤ projectCount xs p := by
  induction xs with
  | nil => simp [projectCount]
  | cons a xs ih =>
    by_cases hf : f a = true <;> by_cases hp : a.project = p <;>
      simp_all [projectCount] <;> omega

theorem reserve_global (s : Store) (id : Nat) :
    (reserve s id).held.length ≤ max s.held.length s.globalLimit := by
  unfold reserve
  split
  · exact Nat.le_max_left _ _
  · split
    · exact Nat.le_max_left _ _
    · split
      · simp only [List.length_cons]; omega
      · exact Nat.le_max_left _ _

theorem reserve_project (s : Store) (id p : Nat) :
    projectCount (reserve s id).held p ≤ max (projectCount s.held p) (s.projectLimit p) := by
  unfold reserve
  split
  · exact Nat.le_max_left _ _
  · rename_i a ha
    split
    · exact Nat.le_max_left _ _
    · split
      · by_cases same : a.project = p
        · subst p
          simp [projectCount] at *
          omega
        · simpa [projectCount, same] using Nat.le_max_left (projectCount s.held p) (s.projectLimit p)
      · exact Nat.le_max_left _ _

/-- Even an arbitrary reply can only retain or remove reservations. -/
theorem respond_counts (s : Store) (ticket : Nat) (r : Reply) (p : Nat) :
    (respond s ticket r).held.length ≤ s.held.length ∧
    projectCount (respond s ticket r).held p ≤ projectCount s.held p := by
  cases r <;> simp only [respond]
  all_goals repeat (first | split | dsimp only | exact ⟨Nat.le_refl _, Nat.le_refl _⟩)
  all_goals first | exact ⟨Nat.le_refl _, Nat.le_refl _⟩ | exact ⟨List.length_filter_le _ _, filter_project_le _ _ _⟩

theorem step_accounting (s : Store) (c : Command) (p : Nat) :
    (step s c).held.length ≤ max s.held.length s.globalLimit ∧
    projectCount (step s c).held p ≤ max (projectCount s.held p) (s.projectLimit p) := by
  cases c with
  | reserve id => exact ⟨reserve_global s id, reserve_project s id p⟩
  | reply t r =>
      exact ⟨Nat.le_trans (respond_counts s t r p).1 (Nat.le_max_left _ _),
             Nat.le_trans (respond_counts s t r p).2 (Nat.le_max_left _ _)⟩
  | terminal id =>
      exact ⟨Nat.le_trans (List.length_filter_le _ _) (Nat.le_max_left _ _),
             Nat.le_trans (filter_project_le _ _ _) (Nat.le_max_left _ _)⟩
  | _ =>
      simp only [step]
      all_goals repeat (first | split | exact ⟨Nat.le_max_left _ _, Nat.le_max_left _ _⟩)

/-- Bounds may cover historical configuration. Reductions retain reservations rather than
retroactively establishing that current usage is below the newly lowered limit. -/
def Bounded (g : Nat) (p : Nat → Nat) (s : Store) : Prop :=
  s.held.length ≤ g ∧ (∀ project, projectCount s.held project ≤ p project) ∧
  s.globalLimit ≤ g ∧ (∀ project, s.projectLimit project ≤ p project)

def Within (g : Nat) (p : Nat → Nat) : Command → Prop
  | .limits nextG nextP => nextG ≤ g ∧ (∀ project, nextP project ≤ p project)
  | _ => True

theorem step_bounded (s : Store) (c : Command) (g : Nat) (p : Nat → Nat)
    (h : Bounded g p s) (hc : Within g p c) : Bounded g p (step s c) := by
  refine ⟨Nat.le_trans (step_accounting s c 0).1 (Nat.max_le.mpr ⟨h.1, h.2.2.1⟩),
    fun project => Nat.le_trans (step_accounting s c project).2 (Nat.max_le.mpr ⟨h.2.1 project, h.2.2.2 project⟩), ?_⟩
  cases c <;> simp only [step, reserve, respond]
  all_goals repeat (first | split | simp_all [release, Within, Bounded])

theorem trace_reservation_bounds (s : Store) (cs : List Command) (g : Nat) (p : Nat → Nat)
    (h : Bounded g p s) (caps : ∀ c ∈ cs, Within g p c) :
    Bounded g p (trace s cs) := by
  induction cs generalizing s with
  | nil => exact h
  | cons c cs ih =>
    exact ih _ (step_bounded s c g p h (caps c (by simp)))
      (by intro cmd hm; exact caps cmd (by simp [hm]))

/-- Durable identity is never overwritten, including restart, delayed replies and stop. -/
theorem step_rows (s : Store) (c : Command) (a : Allocation) (ha : a ∈ s.rows) :
    a ∈ (step s c).rows := by
  cases c <;> simp only [step, reserve, respond]
  all_goals repeat (first | split | simp_all [release])

theorem trace_identity (s : Store) (cs : List Command) (a : Allocation) (ha : a ∈ s.rows) :
    a ∈ (trace s cs).rows := by
  induction cs generalizing s with
  | nil => exact ha
  | cons c cs ih => exact ih _ (step_rows s c a ha)

theorem step_monotone (s : Store) (c : Command) (id : Nat) :
    (id ∈ s.stopped → id ∈ (step s c).stopped) ∧
    (id ∈ s.released → id ∈ (step s c).released) := by
  cases c <;> simp only [step, reserve, respond]
  all_goals repeat (first | split | simp_all [release])

theorem trace_stop_released_monotone (s : Store) (cs : List Command) (id : Nat) :
    (id ∈ s.stopped → id ∈ (trace s cs).stopped) ∧
    (id ∈ s.released → id ∈ (trace s cs).released) := by
  induction cs generalizing s with
  | nil => exact ⟨fun h => h, fun h => h⟩
  | cons c cs ih =>
    exact ⟨fun h => (ih _).1 ((step_monotone s c id).1 h),
           fun h => (ih _).2 ((step_monotone s c id).2 h)⟩

theorem ambiguous_keeps_capacity (s : Store) (ticket : Nat) :
    (respond s ticket .ambiguous).held = s.held := by
  simp only [respond]
  repeat (first | split | rfl)

theorem admission_fences (s : Store) (id epoch profile : Nat)
    (h : admits s id epoch profile = true) :
    id ∉ s.stopped ∧ id ∉ s.drained ∧ id ∉ s.released ∧
    ∃ a, row s id = some a ∧ a.epoch = epoch ∧ a.profile = profile := by
  simp only [admits] at h
  split at h
  · simp only [decide_eq_true_eq] at h
    exact ⟨h.2.2.2.1, h.2.2.2.2.1, h.2.2.2.2.2.1, _, by assumption, h.1, h.2.1⟩
  · contradiction

/-- Lookup stability is stronger than merely retaining historical rows: the same id still
selects exactly the original allocation/profile/epoch after any interleaving. -/
theorem step_lookup (s : Store) (c : Command) (id : Nat) (a : Allocation)
    (found : row s id = some a) : row (step s c) id = some a := by
  cases c with
  | request b =>
    simp only [step]
    split
    · exact found
    · rename_i fresh
      by_cases same : b.id = id
      · simp_all
      · simpa [row, List.find?_cons, same] using found
  | _ =>
    simp only [step, reserve, respond]
    all_goals repeat (first | split | simp_all [release, row])

theorem trace_allocation_identity (s : Store) (cs : List Command) (id : Nat) (a : Allocation)
    (found : row s id = some a) : row (trace s cs) id = some a := by
  induction cs generalizing s with
  | nil => exact found
  | cons c cs ih => exact ih _ (step_lookup s c id a found)

/-- Derivation matches Fleet's constant allocation:create / allocation:launch keys.
The profile and epoch binding attached to either effect cannot be rewritten by a restart. -/
def createIdentity (a : Allocation) := (a.id, a.profile)
def launchIdentity (a : Allocation) := (a.id, a.epoch, a.profile)

theorem trace_create_launch_identity (s : Store) (cs : List Command) (id : Nat) (a : Allocation)
    (found : row s id = some a) :
    (row (trace s cs) id).map createIdentity = some (createIdentity a) ∧
    (row (trace s cs) id).map launchIdentity = some (launchIdentity a) := by
  simp [trace_allocation_identity s cs id a found]

/-- A refusal from one create cannot release capacity once another dispatch was recorded. -/
theorem concurrent_refusal_keeps_capacity (s : Store) (ticket : Nat) (f : Flight)
    (found : flight s ticket = some f) (several : attempts s f.allocation.id ≠ 1) :
    (respond s ticket .refused).held = s.held := by
  simp [respond, found, several]
  repeat (first | split | rfl)

def SameReceipt (before after : Receipt) : Prop :=
  after.machine = before.machine ∧ (before.launch ≠ 0 → after.launch = before.launch)

theorem respond_receipt_identity (s : Store) (ticket id : Nat) (reply : Reply) (prior : Receipt)
    (found : receipt s id = some prior) :
    ∃ next, receipt (respond s ticket reply) id = some next ∧ SameReceipt prior next := by
  by_cases settled : ticket ∈ s.settled
  · simp [respond, settled, found, SameReceipt]
  cases hf : flight s ticket with
  | none => simp [respond, settled, hf, found, SameReceipt]
  | some f =>
    by_cases released : f.allocation.id ∈ s.released
    · simp [respond, settled, hf, released, receipt] at *
      exact ⟨prior, found, rfl, fun _ => rfl⟩
    cases reply <;> simp only [respond, settled, hf, released, ite_false]
    all_goals by_cases same : f.allocation.id = id
    all_goals repeat (first | split | simp_all [receipt, release, SameReceipt])
    all_goals first | exact ⟨prior, found, rfl, fun _ => rfl⟩ | omega

theorem step_receipt_identity (s : Store) (c : Command) (id : Nat) (prior : Receipt)
    (found : receipt s id = some prior) :
    ∃ next, receipt (step s c) id = some next ∧ SameReceipt prior next := by
  cases c with
  | reply t r => exact respond_receipt_identity s t id r prior found
  | _ =>
    simp only [step, reserve, release]
    all_goals repeat (first | split | simp_all [receipt, SameReceipt])

theorem trace_receipt_identity (s : Store) (cs : List Command) (id : Nat) (prior : Receipt)
    (found : receipt s id = some prior) :
    ∃ next, receipt (trace s cs) id = some next ∧ SameReceipt prior next := by
  induction cs generalizing s prior with
  | nil => exact ⟨prior, found, rfl, fun _ => rfl⟩
  | cons c cs ih =>
    obtain ⟨middle, hm, machine, launch⟩ := step_receipt_identity s c id prior found
    obtain ⟨next, hn, machine', launch'⟩ := ih _ middle hm
    refine ⟨next, hn, machine'.trans machine, ?_⟩
    intro launched
    have same := launch launched
    exact (launch' (by simpa [same] using launched)).trans same

end Merv.Fleet
