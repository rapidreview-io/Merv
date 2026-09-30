import Std

/-!
Local Sessions protocol. Rows are retained rather than represented by a single owner,
so exclusivity is a proved invariant. Transactions are serialized atomic commands;
credential/delegation authorization and domain callback correctness are external.
Time is sampled at admission. This does not claim cancellation of already admitted
external effects or of the remainder of a worker's own handoff transaction.
-/
namespace Merv.SessionOwnership

structure Session where
  id : Nat
  target : Nat
  revision : Nat
  actor : Nat
  receipt : Nat
  expires : Nat
  hard : Nat
  deriving Repr, BEq, DecidableEq, Inhabited

structure Invocation where
  id : Nat
  session : Nat
  generation : Nat
  deriving Repr, BEq, DecidableEq, Inhabited

structure Store where
  rows : List Session := []
  closed : List Nat := []
  expired : List Nat := []
  active : List Nat := []
  released : List Nat := []
  revisions : List (Nat × Nat) := []
  generation : Nat := 0
  installed : Bool := true
  time : Nat := 0
  invocations : List Invocation := []
  used : List Nat := []
  effects : Nat := 0
  deriving Repr, Inhabited

def Live (s : Store) (r : Session) : Prop := r ∈ s.rows ∧ r.id ∉ s.closed

def Exclusive (s : Store) : Prop :=
  ∀ a b, Live s a → Live s b →
    ((a.target = b.target ∧ a.revision = b.revision) ∨ a.actor = b.actor) → a.id = b.id

def offerConflict (s : Store) (r : Session) : Bool :=
  s.rows.any fun prior => decide (prior.id = r.id ∨
    (prior.id ∉ s.closed ∧
      ((prior.target = r.target ∧ prior.revision = r.revision) ∨ prior.actor = r.actor)))

def row (s : Store) (id : Nat) : Option Session := s.rows.find? (fun r => r.id == id)
def revision (s : Store) (target : Nat) : Nat :=
  ((s.revisions.find? (fun r => r.1 == target)).map Prod.snd).getD 0

def usable (s : Store) (r : Session) : Bool := decide
  (r.id ∉ s.closed ∧ r.id ∉ s.released ∧ s.time < r.expires ∧
   s.time < r.hard ∧ revision s r.target = r.revision)

inductive Command where
  | offer (session : Session)
  | activate (id : Nat)
  | close (id : Nat) (expired : Bool)
  | release (id receipt : Nat)
  | advance (time : Nat)
  | move (target revision : Nat)
  | reload
  | unload
  | prepare (id session : Nat)
  | run (id : Nat)
  | cancel (id : Nat)
  | restart
  deriving Repr, Inhabited

structure Result where
  store : Store
  outcome : String
  deriving Repr, Inhabited

def unchanged (s : Store) (outcome : String) : Result := ⟨s, outcome⟩

def step (s : Store) : Command → Result
  | .offer r =>
      if offerConflict s r then unchanged s "conflict"
      else ⟨{ s with rows := r :: s.rows }, "offered"⟩
  | .activate id =>
      match row s id with
      | none => unchanged s "missing"
      | some r =>
          if usable s r && s.installed then
            ⟨{ s with active := id :: s.active }, "active"⟩
          else unchanged s "refused"
  | .close id expired =>
      if id ∈ s.closed then unchanged s "unchanged"
      else if (row s id).isSome then
        ⟨{ s with closed := id :: s.closed, expired := (if expired then id :: s.expired else s.expired), released := id :: s.released }, "closed"⟩
      else unchanged s "missing"
  | .release id receipt =>
      match row s id with
      | none => unchanged s "stale_lease"
      | some r =>
          if r.receipt = receipt then
            ⟨{ s with released := id :: s.released }, "released"⟩
          else unchanged s "stale_lease"
  | .advance time => ⟨{ s with time := max s.time time }, "time"⟩
  | .move target rev =>
      ⟨{ s with revisions := (target, rev) :: s.revisions }, "moved"⟩
  | .reload => ⟨{ s with generation := s.generation + 1, installed := true }, "reloaded"⟩
  | .unload => ⟨{ s with installed := false }, "unloaded"⟩
  | .prepare id session =>
      if s.invocations.any (fun i => i.id == id) then unchanged s "invocation"
      else match row s session with
      | none => unchanged s "missing"
      | some r =>
          if usable s r && s.installed then
            ⟨{ s with invocations := ⟨id, session, s.generation⟩ :: s.invocations }, "prepared"⟩
          else unchanged s "refused"
  | .run id =>
      if id ∈ s.used then unchanged s "invocation"
      else match s.invocations.find? (fun i => i.id == id) with
      | none => unchanged s "invocation"
      | some i =>
          let consumed := { s with used := id :: s.used }
          if !s.installed then unchanged consumed "refused"
          else if i.generation ≠ s.generation then unchanged consumed "execution_replaced"
          else match row s i.session with
          | none => unchanged consumed "missing"
          | some r =>
              if usable s r then ⟨{ consumed with effects := s.effects + 1 }, "executed"⟩
              else unchanged consumed "refused"
  | .cancel id => ⟨{ s with used := id :: s.used }, "cancelled"⟩
  | .restart => ⟨{ s with invocations := [], used := [], generation := s.generation + 1 }, "restarted"⟩

theorem offer_preserves_exclusive (s : Store) (r : Session) (h : Exclusive s) :
    Exclusive (step s (.offer r)).store := by
  simp only [step]
  split
  · exact h
  · rename_i free
    have fresh : ∀ prior ∈ s.rows, prior.id ≠ r.id ∧
        (prior.id ∉ s.closed →
          ¬ ((prior.target = r.target ∧ prior.revision = r.revision) ∨ prior.actor = r.actor)) := by
      simpa [offerConflict, List.any_eq_false, not_or, not_and] using free
    intro a b ha hb clash
    simp only [Live, List.mem_cons] at ha hb
    rcases ha with ⟨ha | ha, hac⟩ <;> rcases hb with ⟨hb | hb, hbc⟩
    · exact congrArg Session.id (ha.trans hb.symm)
    · subst a
      have bad := (fresh b hb).2 hbc
      apply False.elim
      apply bad
      rcases clash with ht | ht
      · exact Or.inl ⟨ht.1.symm, ht.2.symm⟩
      · exact Or.inr ht.symm
    · subst b
      exact False.elim ((fresh a ha).2 hac clash)
    · exact h a b ⟨ha, hac⟩ ⟨hb, hbc⟩ clash

-- Every non-offer retains the immutable rows and can only remove live ownership.
theorem nonoffer_live_subset (s : Store) (c : Command)
    (notOffer : ∀ r, c ≠ .offer r) (r : Session) :
    Live (step s c).store r → Live s r := by
  cases c <;> simp only [step]
  all_goals repeat (first | split | simp_all [unchanged, Live])

theorem step_preserves_exclusive (s : Store) (c : Command) (h : Exclusive s) :
    Exclusive (step s c).store := by
  by_cases offer : ∃ r, c = .offer r
  · obtain ⟨r, rfl⟩ := offer
    exact offer_preserves_exclusive s r h
  · have notOffer : ∀ r, c ≠ .offer r := by simpa using offer
    intro a b ha hb clash
    exact h a b (nonoffer_live_subset s c notOffer a ha)
      (nonoffer_live_subset s c notOffer b hb) clash

def trace (s : Store) (commands : List Command) : Store :=
  commands.foldl (fun s c => (step s c).store) s

theorem trace_preserves_exclusive (s : Store) (commands : List Command) (h : Exclusive s) :
    Exclusive (trace s commands) := by
  induction commands generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (step_preserves_exclusive s c h)

theorem closed_preserved (s : Store) (c : Command) (id : Nat) (h : id ∈ s.closed) :
    id ∈ (step s c).store.closed := by
  cases c <;> simp only [step]
  all_goals repeat (first | split | simp_all [unchanged])

theorem trace_terminal (s : Store) (commands : List Command) (id : Nat)
    (h : id ∈ s.closed) : id ∈ (trace s commands).closed := by
  induction commands generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (closed_preserved s c id h)

theorem release_preserves_successor (s : Store) (old receipt successor : Nat)
    (different : successor ≠ old) :
    successor ∈ (step s (.release old receipt)).store.released ↔ successor ∈ s.released := by
  simp only [step]
  repeat (first | split | simp_all [unchanged])

theorem wrong_receipt_unchanged (s : Store) (id receipt : Nat) (r : Session)
    (found : row s id = some r) (wrong : r.receipt ≠ receipt) :
    (step s (.release id receipt)).store = s := by
  simp [step, found, wrong, unchanged]

theorem run_requires_current_generation (s : Store) (id : Nat)
    (success : (step s (.run id)).outcome = "executed") :
    ∃ i, s.invocations.find? (fun i => i.id == id) = some i ∧
      i.generation = s.generation ∧ id ∉ s.used ∧
      ∃ r, row s i.session = some r ∧ usable s r = true := by
  simp only [step] at success
  repeat (first | split at success | simp_all [unchanged])
  all_goals exact ⟨_, by assumption, by assumption, by assumption, _, by assumption, by assumption⟩

theorem expired_not_usable (s : Store) (r : Session)
    (expired : r.expires ≤ s.time ∨ r.hard ≤ s.time) : usable s r = false := by
  simp only [usable, decide_eq_false_iff_not]
  omega

theorem used_run_no_effect (s : Store) (id : Nat) (used : id ∈ s.used) :
    (step s (.run id)).store.effects = s.effects := by
  simp [step, used, unchanged]

theorem run_consumes (s : Store) (id : Nat)
    (success : (step s (.run id)).outcome = "executed") :
    id ∈ (step s (.run id)).store.used := by
  simp only [step] at success ⊢
  repeat (first | split at success | simp_all [unchanged])


theorem retained_assignment_preserved (s : Store) (c : Command) (r : Session)
    (retained : r ∈ s.rows) : r ∈ (step s c).store.rows := by
  cases c <;> simp only [step]
  all_goals repeat (first | split | simp_all [unchanged])

theorem trace_retains_assignment (s : Store) (commands : List Command) (r : Session)
    (retained : r ∈ s.rows) : r ∈ (trace s commands).rows := by
  induction commands generalizing s with
  | nil => exact retained
  | cons c cs ih => exact ih _ (retained_assignment_preserved s c r retained)

theorem replaced_preparation_cannot_execute (s : Store) (id : Nat) (i : Invocation)
    (found : s.invocations.find? (fun i => i.id == id) = some i)
    (replaced : i.generation ≠ s.generation) :
    (step s (.run id)).outcome ≠ "executed" := by
  simp only [step, found]
  repeat (first | split | simp_all [unchanged])

theorem closed_not_usable (s : Store) (r : Session) (closed : r.id ∈ s.closed) :
    usable s r = false := by
  simp [usable, closed]

end Merv.SessionOwnership
