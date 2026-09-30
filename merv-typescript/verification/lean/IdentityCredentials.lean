import Std

/-! Hashes, validated identifiers and canonical millisecond timestamps are abstracted by naturals.
The ledger is a partial map, so hash uniqueness is structural. Owner is the lifecycle service
argument, not an assertion about an untrusted bearer. Commands are serialized transactions. -/
namespace Merv.IdentityCredentials

structure Identity where
  owner : Nat
  subject : Nat
  kind : Nat
  deadline : Option Nat
  created : Nat
  deriving Repr, DecidableEq, BEq

structure Row where
  identity : Identity
  expires : Option Nat
  revoked : Option Nat := none
  deriving Repr, DecidableEq, BEq

structure Input where
  owner : Nat
  subject : Nat
  kind : Nat
  expires : Option Nat
  deadline : Option Nat
  deriving Repr

def bounded (expires deadline : Option Nat) : Bool :=
  match deadline, expires with
  | none, _ => true
  | some d, some e => decide (e ≤ d)
  | some _, none => false

def before (now : Nat) : Option Nat → Bool
  | none => true
  | some endTime => decide (now < endTime)

def live (now : Nat) (r : Row) : Bool :=
  r.revoked.isNone && before now r.expires && before now r.identity.deadline

def fresh (now : Nat) (i : Input) : Row :=
  ⟨⟨i.owner, i.subject, i.kind, i.deadline, now⟩, i.expires, none⟩

inductive Operation where
  | issue (input : Input)
  | adopt (input : Input)
  | renew (owner expires : Nat)
  | revoke (owner : Nat)
  | revokeSubject (owner subject kind : Nat)
  | authenticate (kinds : List Nat)
  deriving Repr

structure Result where
  row : Option Row
  outcome : String
  deriving Repr

def unchanged (r : Option Row) (outcome : String) : Result := ⟨r, outcome⟩

def evolve (now : Nat) (old : Option Row) : Operation → Result
  | .issue i =>
      if !(bounded i.expires i.deadline && before now i.expires) then
        unchanged old "invalid_credential"
      else match old with
      | some _ => unchanged old "credential_conflict"
      | none => ⟨some (fresh now i), "ok"⟩
  | .adopt i =>
      if !bounded i.expires i.deadline then unchanged old "invalid_credential"
      else match old with
      | none => ⟨some (fresh now i), "ok"⟩
      | some r => unchanged old (if r.identity.owner = i.owner ∧
          r.identity.subject = i.subject ∧ r.identity.kind = i.kind then "ok"
          else "credential_conflict")
  | .renew owner expires =>
      match old with
      | none => unchanged old "credential_forbidden"
      | some r =>
          if r.identity.owner ≠ owner then unchanged old "credential_forbidden"
          else match r.identity.deadline with
          | none => unchanged old "invalid_credential"
          | some deadline =>
              if !live now r then unchanged old "unauthorized"
              else match r.expires with
              | none => unchanged old "unauthorized"
              | some previous =>
                  if ¬ (now < expires ∧ expires ≤ deadline) then
                    unchanged old "invalid_credential"
                  else if expires ≤ previous then unchanged old "ok"
                  else ⟨some { r with expires := some expires }, "ok"⟩
  | .revoke owner =>
      match old with
      | none => unchanged old "missing"
      | some r =>
          if r.identity.owner ≠ owner then unchanged old "credential_forbidden"
          else ⟨some { r with revoked := r.revoked.or (some now) }, "ok"⟩
  | .revokeSubject owner subject kind =>
      match old with
      | none => unchanged old "ok"
      | some r =>
          if r.identity.owner = owner ∧ r.identity.subject = subject ∧ r.identity.kind = kind
          then ⟨some { r with revoked := r.revoked.or (some now) }, "ok"⟩
          else unchanged old "ok"
  | .authenticate kinds =>
      unchanged old (match old with
      | some r => if r.identity.kind ∈ kinds ∧ live now r then "ok" else "unauthorized"
      | none => "unauthorized")

structure Store where
  rows : Nat → Option Row := fun _ => none
  time : Nat := 0

inductive Command where
  | at (hash : Nat) (operation : Operation)
  | revokeSubject (owner subject kind : Nat)
  | advance (time : Nat)

-- Clock samples may go backwards: expiry is a current-time predicate, revocation is sticky.
def step (s : Store) : Command → Store
  | .at hash op => { s with rows := fun key =>
      if key = hash then (evolve s.time (s.rows key) op).row else s.rows key }
  | .revokeSubject o u k => { s with rows := fun key =>
      (evolve s.time (s.rows key) (.revokeSubject o u k)).row }
  | .advance now => { s with time := now }

def trace (s : Store) (commands : List Command) : Store := commands.foldl step s

def ExpiryExtends (a b : Option Nat) : Prop :=
  match a, b with
  | none, none => True
  | some a, some b => a ≤ b
  | _, _ => False

instance (a b : Option Nat) : Decidable (ExpiryExtends a b) := by
  unfold ExpiryExtends; split <;> infer_instance

def Retains (a b : Row) : Prop :=
  b.identity = a.identity ∧ ExpiryExtends a.expires b.expires ∧
    (a.revoked ≠ none → b = a)

theorem expiry_refl (e : Option Nat) : ExpiryExtends e e := by cases e <;> simp [ExpiryExtends]
theorem retains_refl (r : Row) : Retains r r := ⟨rfl, expiry_refl _, fun _ => rfl⟩
theorem expiry_trans (a b c : Option Nat) (ab : ExpiryExtends a b)
    (bc : ExpiryExtends b c) : ExpiryExtends a c := by
  cases a <;> cases b <;> cases c <;> simp_all [ExpiryExtends]
  omega

theorem retains_trans (a b c : Row) (ab : Retains a b) (bc : Retains b c) : Retains a c := by
  refine ⟨bc.1.trans ab.1, expiry_trans _ _ _ ab.2.1 bc.2.1, ?_⟩
  intro h
  have eq := ab.2.2 h
  subst b
  exact bc.2.2 h

-- An existing hash is never deleted, re-owned, rebound, shortened or un-revoked.
theorem evolve_retains (now : Nat) (r : Row) (op : Operation) :
    ∃ next, (evolve now (some r) op).row = some next ∧ Retains r next := by
  cases op <;> simp only [evolve]
  all_goals repeat (first | split | exact ⟨r, rfl, retains_refl r⟩)
  all_goals simp_all [Retains, live, ExpiryExtends]
  all_goals try omega
  all_goals try exact ⟨r, rfl, rfl, expiry_refl _, fun _ => rfl⟩
  all_goals
    refine ⟨expiry_refl _, ?_⟩
    cases r with
    | mk identity expires revoked => cases revoked <;> simp_all

-- Every insertion is bounded; every renewal respects the original hard deadline.
theorem evolve_bounded (now : Nat) (old : Option Row) (op : Operation)
    (h : ∀ r, old = some r → bounded r.expires r.identity.deadline = true) :
    ∀ r, (evolve now old op).row = some r → bounded r.expires r.identity.deadline = true := by
  cases op <;> simp only [evolve]
  all_goals repeat (first | split | simp_all [unchanged, fresh, bounded])

theorem step_retains (s : Store) (c : Command) (key : Nat) (r : Row)
    (found : s.rows key = some r) :
    ∃ next, (step s c).rows key = some next ∧ Retains r next := by
  cases c <;> simp only [step]
  · split
    · simpa [found] using evolve_retains s.time r _
    · exact ⟨r, found, retains_refl r⟩
  · simpa [found] using evolve_retains s.time r _
  · exact ⟨r, found, retains_refl r⟩

theorem trace_retains_identity_expiry_revocation (s : Store) (commands : List Command)
    (key : Nat) (r : Row) (found : s.rows key = some r) :
    ∃ next, (trace s commands).rows key = some next ∧ Retains r next := by
  induction commands generalizing s r with
  | nil => exact ⟨r, found, retains_refl r⟩
  | cons c cs ih =>
      obtain ⟨b, hb, hab⟩ := step_retains s c key r found
      obtain ⟨d, hd, hbd⟩ := ih (step s c) b hb
      exact ⟨d, hd, retains_trans r b d hab hbd⟩

def Bounded (s : Store) : Prop :=
  ∀ key r, s.rows key = some r → bounded r.expires r.identity.deadline = true

theorem step_bounded (s : Store) (c : Command) (h : Bounded s) : Bounded (step s c) := by
  intro key
  cases c <;> simp only [step]
  · split
    · exact evolve_bounded _ _ _ (h key)
    · exact h key
  · exact evolve_bounded _ _ _ (h key)
  · exact h key

theorem trace_bounded (s : Store) (commands : List Command) (h : Bounded s) :
    Bounded (trace s commands) := by
  induction commands generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (step_bounded s c h)

theorem empty_trace_bounded (commands : List Command) : Bounded (trace {} commands) :=
  trace_bounded _ _ (by intro key r h; cases h)

theorem adopt_existing_unchanged (now : Nat) (r : Row) (i : Input) :
    (evolve now (some r) (.adopt i)).row = some r := by
  simp [evolve, unchanged]; split <;> rfl

theorem unknown_revoke_no_tombstone (now owner : Nat) :
    (evolve now none (.revoke owner)).row = none := rfl

theorem renewal_owner_only (now : Nat) (r : Row) (owner expires : Nat)
    (wrong : r.identity.owner ≠ owner) :
    (evolve now (some r) (.renew owner expires)).row = some r := by
  simp [evolve, wrong, unchanged]

theorem revocation_owner_only (now : Nat) (r : Row) (owner : Nat)
    (wrong : r.identity.owner ≠ owner) :
    (evolve now (some r) (.revoke owner)).row = some r := by
  simp [evolve, wrong, unchanged]

theorem expired_renewal_unchanged (now : Nat) (r : Row) (owner expires : Nat)
    (expired : live now r = false) :
    (evolve now (some r) (.renew owner expires)).row = some r := by
  simp only [evolve]; repeat (first | split | simp_all [unchanged])

theorem renewal_success_requires_owner_and_live_record (now : Nat) (r : Row)
    (owner expires : Nat) (success : (evolve now (some r) (.renew owner expires)).outcome = "ok") :
    r.identity.owner = owner ∧ live now r = true ∧
      ∃ deadline, r.identity.deadline = some deadline ∧ now < expires ∧ expires ≤ deadline := by
  simp only [evolve] at success
  repeat (first | split at success | simp_all [unchanged])

theorem revoke_subject_other_authority_unchanged (now : Nat) (r : Row)
    (owner subject kind : Nat)
    (other : r.identity.owner ≠ owner ∨ r.identity.subject ≠ subject ∨ r.identity.kind ≠ kind) :
    (evolve now (some r) (.revokeSubject owner subject kind)).row = some r := by
  simp only [evolve]
  split
  · simp_all
  · rfl

theorem authenticate_iff (now : Nat) (old : Option Row) (kinds : List Nat) :
    (evolve now old (.authenticate kinds)).outcome = "ok" ↔
      ∃ r, old = some r ∧ r.identity.kind ∈ kinds ∧ live now r = true := by
  cases old <;> simp [evolve, unchanged]

theorem revoked_never_authenticates (s : Store) (commands : List Command) (key : Nat)
    (r : Row) (found : s.rows key = some r) (revoked : r.revoked ≠ none) (kinds : List Nat) :
    (evolve (trace s commands).time ((trace s commands).rows key) (.authenticate kinds)).outcome
      ≠ "ok" := by
  obtain ⟨next, hn, hr⟩ := trace_retains_identity_expiry_revocation s commands key r found
  have eq := hr.2.2 revoked
  subst next
  rw [hn]
  intro success
  obtain ⟨x, hx, _, hl⟩ := (authenticate_iff _ _ _).mp success
  cases hx
  cases hrev : r.revoked <;> simp_all [live]

end Merv.IdentityCredentials
