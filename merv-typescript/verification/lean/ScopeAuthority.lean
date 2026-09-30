import Std

/-! Scope's normalized records. Membership rows represent the consistent join of actors,
member_actors, shared_users and project_memberships. Administrative membership commands
are already authorized transactions; this model does not prove last-operator admission.
Independent actor issuance is provisioning, not a worker delegation edge. -/
namespace Merv.ScopeAuthority

inductive Role where
  | operator | producer | reviewer | reader
  deriving Repr, BEq, DecidableEq
inductive Permission where
  | read | write | review | admin
  deriving Repr, BEq, DecidableEq

def permits (role : Role) (permission : Permission) : Bool :=
  match role, permission with
  | _, .read => true
  | .operator, _ => true
  | .producer, .write => true
  | .reviewer, .review => true
  | _, _ => false

def needs : Role → Permission
  | .producer => .write
  | .reviewer => .review
  | .reader => .read
  | .operator => .admin

def workerAllowed (source child : Role) : Bool :=
  child != .operator && permits source (needs child)

structure Membership where
  epoch : Nat
  project : Nat
  subject : Nat
  role : Role
  deriving Repr, BEq, DecidableEq
structure Key where
  id : Nat
  subject : Nat
  project : Nat
  account : Bool
  expires : Option Nat
  deriving Repr, BEq, DecidableEq
structure Actor where
  id : Nat
  project : Nat
  role : Role
  deriving Repr, BEq, DecidableEq
structure Source where
  epoch : Nat
  project : Nat
  subject : Nat
  key : Option Nat := none
  deriving Repr, BEq, DecidableEq

structure Store where
  members : List Membership := []
  retired : List Nat := []
  keys : List Key := []
  revokedKeys : List Nat := []
  actors : List Actor := []
  revokedActors : List Nat := []
  next : Nat := 1
  time : Nat := 0
  deriving Repr

def current (s : Store) (project subject : Nat) : Option Membership :=
  s.members.find? fun m => decide (m.project = project ∧ m.subject = subject ∧ m.epoch ∉ s.retired)
def before (time : Nat) : Option Nat → Bool
  | none => true
  | some expires => decide (time < expires)
def keyLive (s : Store) (k : Key) (project : Nat) : Bool :=
  decide (k.id ∉ s.revokedKeys) && before s.time k.expires &&
    (k.account || k.project == project)
def keyFor (s : Store) (key project subject : Nat) : Bool :=
  s.keys.any fun k => k.id == key && k.subject == subject && keyLive s k project

def sourceRole (s : Store) (src : Source) : Option Role :=
  match s.members.find? (fun m => m.epoch == src.epoch) with
  | none => none
  | some m =>
      if m.project = src.project ∧ m.subject = src.subject ∧ m.epoch ∉ s.retired then
        if src.key.all (fun key => keyFor s key src.project src.subject) then some m.role else none
      else none

def delegated (s : Store) (src : Source) (permission : Permission) : Bool :=
  (sourceRole s src).any (fun role => permits role permission)

def human (s : Store) (src : Source) (jwtExpiry : Nat) (permission : Permission) : Bool :=
  decide (s.time < jwtExpiry) && delegated s src permission

-- A new account-key request resolves today's membership, while a prepared source pins its epoch.
def keyAuthority (s : Store) (id project : Nat) (permission : Permission) : Bool :=
  s.keys.any fun k => k.id == id && keyLive s k project &&
    (current s project k.subject).any (fun m => permits m.role permission)

def actorAuthority (s : Store) (id project : Nat) (permission : Permission) : Bool :=
  s.actors.any fun a => a.id == id && a.project == project &&
    decide (a.id ∉ s.revokedActors) && permits a.role permission

-- The trusted Fleet review service is intentionally not a permission-subset edge.
def serviceAuthority (s : Store) (src : Source) (project : Nat) (reviewService : Bool)
    (permission : Permission) : Bool :=
  decide (src.project = project) && delegated s src .write &&
    permits (if reviewService then .reviewer else .producer) permission

inductive Command where
  | grant (project subject : Nat) (role : Role)
  | remove (project subject : Nat)
  | issueKey (key : Key)
  | revokeKey (id : Nat)
  | issueActor (actor : Actor)
  | revokeActor (id : Nat)
  | advance (time : Nat)
  deriving Repr

def retireCurrent (s : Store) (project subject : Nat) : List Nat :=
  match current s project subject with
  | none => s.retired
  | some m => m.epoch :: s.retired

def step (s : Store) : Command → Store
  | .grant project subject role =>
      if (current s project subject).any (fun m => decide (m.role = role)) then s
      else { s with members := ⟨s.next, project, subject, role⟩ :: s.members, retired := retireCurrent s project subject, next := s.next + 1 }
  | .remove project subject => { s with retired := retireCurrent s project subject }
  | .issueKey key =>
      if s.keys.any (fun k => k.id == key.id) then s else { s with keys := key :: s.keys }
  | .revokeKey id => { s with revokedKeys := id :: s.revokedKeys }
  | .issueActor actor =>
      if s.actors.any (fun a => a.id == actor.id) then s
      else { s with actors := actor :: s.actors }
  | .revokeActor id => { s with revokedActors := id :: s.revokedActors }
  | .advance now => { s with time := now }

def trace (s : Store) (commands : List Command) : Store := commands.foldl step s

theorem worker_permission_subset (parent child : Role) (permission : Permission)
    (allowed : workerAllowed parent child = true)
    (held : permits child permission = true) : permits parent permission = true := by
  cases parent <;> cases child <;> cases permission <;> simp_all [workerAllowed, needs, permits]

theorem producer_reviewer_incomparable :
    workerAllowed .producer .reviewer = false ∧ workerAllowed .reviewer .producer = false := by
  decide

theorem worker_never_operator (parent : Role) : workerAllowed parent .operator = false := by
  cases parent <;> decide

theorem retire_keeps (s : Store) (project subject epoch : Nat) (h : epoch ∈ s.retired) :
    epoch ∈ retireCurrent s project subject := by
  simp only [retireCurrent]; split <;> simp_all

theorem step_retired (s : Store) (c : Command) (epoch : Nat) (h : epoch ∈ s.retired) :
    epoch ∈ (step s c).retired := by
  cases c <;> simp only [step]
  all_goals repeat (first | split | exact h | apply retire_keeps _ _ _ _ h)

theorem trace_retired (s : Store) (commands : List Command) (epoch : Nat)
    (h : epoch ∈ s.retired) : epoch ∈ (trace s commands).retired := by
  induction commands generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (step_retired s c epoch h)

theorem source_role_requires_record (s : Store) (src : Source) (role : Role)
    (h : sourceRole s src = some role) :
    ∃ m ∈ s.members, m.epoch = src.epoch ∧ m.project = src.project ∧
      m.subject = src.subject ∧ m.epoch ∉ s.retired ∧ m.role = role := by
  cases found : s.members.find? (fun m => m.epoch == src.epoch) with
  | none => simp [sourceRole, found] at h
  | some m =>
    have hm := List.mem_of_find?_eq_some found
    have epoch : m.epoch = src.epoch := by
      simpa using List.find?_some found
    simp only [sourceRole, found] at h
    split at h
    · rename_i bound
      split at h
      · cases h; exact ⟨m, hm, epoch, bound.1, bound.2.1, bound.2.2, rfl⟩
      · cases h
    · cases h

theorem retired_source_denied (s : Store) (src : Source) (permission : Permission)
    (h : src.epoch ∈ s.retired) : delegated s src permission = false := by
  cases hr : sourceRole s src with
  | none => simp [delegated, hr]
  | some role =>
      obtain ⟨m, _, he, _, _, hn, _⟩ := source_role_requires_record s src role hr
      exact False.elim (hn (he.symm ▸ h))

theorem arbitrary_trace_epoch_invalidation (s : Store) (commands : List Command)
    (src : Source) (permission : Permission) (h : src.epoch ∈ s.retired) :
    delegated (trace s commands) src permission = false :=
  retired_source_denied _ _ _ (trace_retired s commands src.epoch h)

-- Link the persistent invariant to actual membership mutations, not a supplied validity flag.
theorem removal_invalidates_arbitrary_future (s : Store) (commands : List Command)
    (project subject : Nat) (m : Membership) (key : Option Nat) (permission : Permission)
    (found : current s project subject = some m) :
    delegated (trace (step s (.remove project subject)) commands)
      ⟨m.epoch, project, subject, key⟩ permission = false := by
  apply arbitrary_trace_epoch_invalidation
  simp [step, retireCurrent, found]

theorem role_change_invalidates_arbitrary_future (s : Store) (commands : List Command)
    (project subject : Nat) (m : Membership) (role : Role) (key : Option Nat)
    (permission : Permission) (found : current s project subject = some m)
    (changed : m.role ≠ role) :
    delegated (trace (step s (.grant project subject role)) commands)
      ⟨m.epoch, project, subject, key⟩ permission = false := by
  apply arbitrary_trace_epoch_invalidation
  simp [step, retireCurrent, found, changed]

-- Fresh allocation cannot recycle a historical epoch.
def EpochsBelowNext (s : Store) : Prop := ∀ m ∈ s.members, m.epoch < s.next

theorem step_fresh_epochs (s : Store) (c : Command) (h : EpochsBelowNext s) :
    EpochsBelowNext (step s c) := by
  cases c <;> simp only [step]
  all_goals repeat (first | split | exact h)
  intro m hm
  simp only [List.mem_cons] at hm
  rcases hm with hm | hm
  · subst m; simp
  · have := h m hm
    change m.epoch < s.next + 1
    omega

theorem trace_fresh_epochs (commands : List Command) : EpochsBelowNext (trace {} commands) := by
  have general : ∀ s, EpochsBelowNext s → EpochsBelowNext (trace s commands) := by
    induction commands with
    | nil => intro s h; exact h
    | cons c cs ih => intro s h; exact ih _ (step_fresh_epochs s c h)
  exact general {} (by intro m hm; cases hm)

theorem delegated_project_binding (s : Store) (src : Source) (permission : Permission)
    (allowed : delegated s src permission = true) :
    ∃ m ∈ s.members, m.epoch = src.epoch ∧ m.project = src.project ∧
      m.subject = src.subject ∧ m.epoch ∉ s.retired ∧ permits m.role permission = true := by
  cases hr : sourceRole s src with
  | none => simp [delegated, hr] at allowed
  | some role =>
      obtain ⟨m, hm, he, hp, hu, hn, hrole⟩ := source_role_requires_record s src role hr
      exact ⟨m, hm, he, hp, hu, hn, by simpa [delegated, hr, hrole] using allowed⟩

theorem key_authority_requires_current_membership (s : Store) (id project : Nat)
    (permission : Permission) (h : keyAuthority s id project permission = true) :
    ∃ k ∈ s.keys, k.id = id ∧ keyLive s k project = true ∧
      ∃ m, current s project k.subject = some m ∧ permits m.role permission = true := by
  simp only [keyAuthority, List.any_eq_true, Bool.and_eq_true, beq_iff_eq] at h
  obtain ⟨k, hk, ⟨hid, hl⟩, hm⟩ := h
  refine ⟨k, hk, hid, hl, ?_⟩
  cases found : current s project k.subject with
  | none => simp [found] at hm
  | some m => exact ⟨m, rfl, by simpa [found] using hm⟩

theorem project_key_cannot_cross_project (s : Store) (k : Key) (project : Nat)
    (restricted : k.account = false) (wrong : k.project ≠ project) :
    keyLive s k project = false := by
  simp [keyLive, restricted, wrong]

theorem human_jwt_expiry_denied (s : Store) (src : Source) (expires : Nat)
    (permission : Permission) (h : expires ≤ s.time) : human s src expires permission = false := by
  simp [human, show ¬s.time < expires by omega]

theorem service_requires_same_project_and_writer (s : Store) (src : Source)
    (project : Nat) (reviewService : Bool) (permission : Permission)
    (h : serviceAuthority s src project reviewService permission = true) :
    src.project = project ∧ delegated s src .write = true := by
  simp only [serviceAuthority, Bool.and_eq_true, decide_eq_true_eq] at h
  exact h.1

-- Concrete counterexample to an overbroad universal delegation-subset claim.
def reviewException : Store := { members := [⟨1, 1, 1, .producer⟩], next := 2 }
theorem trusted_review_service_exception :
    delegated reviewException ⟨1, 1, 1, none⟩ .review = false ∧
    serviceAuthority reviewException ⟨1, 1, 1, none⟩ 1 true .review = true := by
  decide

end Merv.ScopeAuthority
