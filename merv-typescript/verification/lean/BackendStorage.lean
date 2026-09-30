import ScopeAuthority

/-! Product storage at transaction/blob boundaries. Byte strings are abstracted by collision-free
content tokens: an explicit external contract, not a SHA-256 proof. Records contain no proofs. -/
namespace Merv.BackendStorage
structure Caller where
  actor : Nat
  project : Nat
  expires : Option Nat := none
  deriving Repr, BEq, DecidableEq
structure Ticket where
  actor : Nat
  project : Nat
  hash : String
  size : Nat
  title : String
  media : String
  deriving Repr, BEq, DecidableEq
structure Content where
  token : String
  size : Nat
  deriving Repr, BEq, DecidableEq
structure Artifact where
  serial : Nat
  ticket : Ticket
  deriving Repr, BEq, DecidableEq
structure Pending where
  upload : Nat
  caller : Caller
  ticket : Ticket
  deriving Repr
structure Store where
  authority : ScopeAuthority.Store := {}
  tickets : Nat → Option Ticket := fun _ => none
  objects : Nat → String → Option Content := fun _ _ => none
  attached : Nat → Option Artifact := fun _ => none
  pending : Nat → Option Pending := fun _ => none
  next : Nat := 1

def update (f : Nat → α) (key : Nat) (value : α) : Nat → α :=
  fun k => if k = key then value else f k

def writable (s : Store) (c : Caller) : Bool :=
  ScopeAuthority.actorAuthority s.authority c.actor c.project .write &&
    ScopeAuthority.before s.authority.time c.expires

def owns (c : Caller) (t : Ticket) : Bool := c.actor == t.actor && c.project == t.project

def begin (s : Store) (id : Nat) (c : Caller) (t : Ticket) : Store × String :=
  if !writable s c then (s, "forbidden")
  else if !owns c t then (s, "upload_conflict")
  else match s.tickets id with
    | some old => if old = t then (s, "begun") else (s, "upload_conflict")
    | none => ({ s with tickets := update s.tickets id (some t) }, "begun")

-- Conditional object persistence may precede loss of the response.
def put (s : Store) (project : Nat) (hash : String) (content : Content)
    (lost : Bool) : Store × String :=
  if content.token ≠ hash then (s, "bad_digest")
  else match s.objects project hash with
    | some _ => (s, "exists")
    | none =>
      ({ s with objects := fun p h =>
          if p = project ∧ h = hash then some content else s.objects p h },
        if lost then "lost" else "stored")

-- The short authorized read snapshot precedes external blob I/O.
def start (s : Store) (op id : Nat) (c : Caller) : Store × String :=
  if !writable s c then (s, "forbidden")
  else match s.tickets id with
    | none => (s, "not_found")
    | some t =>
      if !owns c t then (s, "not_found")
      else match s.attached id with
        | some _ => (s, "complete")
        | none => ({ s with pending := update s.pending op (some ⟨id, c, t⟩) }, "started")

-- State serialization plus FOR UPDATE orders finalizers. Fresh authorization is the write
-- linearization point; this does not assert that wall-clock time is frozen until COMMIT.
def commit (s : Store) (p : Pending) : Store × String :=
  if !writable s p.caller then (s, "forbidden")
  else match s.attached p.upload with
    | some _ => (s, "complete")
    | none =>
      ({ s with attached := update s.attached p.upload (some ⟨s.next, p.ticket⟩),
                next := s.next + 1 }, "complete")

def finish (s : Store) (op : Nat) (outage lost : Bool) : Store × String :=
  match s.pending op with
  | none => (s, "no_operation")
  | some p =>
    if outage then (s, "blob_unavailable")
    else match s.objects p.ticket.project p.ticket.hash with
    | none => (s, "upload_pending")
    | some content =>
      if content.size ≠ p.ticket.size then (s, "upload_mismatch")
      else
        let result := commit s p
        (result.1, if lost && result.2 == "complete" then "lost" else result.2)

inductive Command where
  | grant (actor project : Nat) (role : ScopeAuthority.Role)
  | revoke (actor : Nat)
  | advance (time : Nat)
  | begin (id : Nat) (caller : Caller) (ticket : Ticket)
  | put (project : Nat) (hash : String) (content : Content) (lost : Bool)
  | start (op id : Nat) (caller : Caller)
  | finish (op : Nat) (outage lost : Bool)
  | restart
  deriving Repr

def step (s : Store) : Command → Store × String
  | .grant actor project role =>
      ({ s with authority := ScopeAuthority.step s.authority (.issueActor ⟨actor, project, role⟩) }, "granted")
  | .revoke actor =>
      ({ s with authority := ScopeAuthority.step s.authority (.revokeActor actor) }, "revoked")
  | .advance time =>
      ({ s with authority := ScopeAuthority.step s.authority (.advance time) }, "advanced")
  | .begin id c t => begin s id c t
  | .put project hash content lost => put s project hash content lost
  | .start op id c => start s op id c
  | .finish op outage lost => finish s op outage lost
  | .restart => ({ s with pending := fun _ => none }, "restarted")

def trace (s : Store) (commands : List Command) : Store :=
  commands.foldl (fun s c => (step s c).1) s

-- Separately stored ordinary records, connected by the invariant rather than by their types.
def Safe (s : Store) : Prop :=
  (∀ op p, s.pending op = some p → s.tickets p.upload = some p.ticket ∧ owns p.caller p.ticket = true) ∧
  (∀ id a, s.attached id = some a → s.tickets id = some a.ticket ∧
    ∃ content, s.objects a.ticket.project a.ticket.hash = some content ∧
      content.token = a.ticket.hash ∧ content.size = a.ticket.size) ∧
  (∀ project hash content, s.objects project hash = some content → content.token = hash)

theorem initial_safe : Safe {} := by simp [Safe]

theorem begin_tickets_immutable (s : Store) (id key : Nat) (c : Caller) (t old : Ticket)
    (h : s.tickets key = some old) : (begin s id c t).1.tickets key = some old := by
  unfold begin
  split <;> try exact h
  split <;> try exact h
  split <;> try (split <;> exact h)
  rename_i absent
  simp only [update]
  split
  · rename_i same; subst key; simp_all
  · exact h

theorem commit_bindings_immutable (s : Store) (p : Pending) (id : Nat) (a : Artifact)
    (h : s.attached id = some a) : (commit s p).1.attached id = some a := by
  unfold commit
  split <;> try exact h
  split <;> try exact h
  rename_i absent
  simp only [update]
  split
  · rename_i same; subst id; simp_all
  · exact h

theorem finish_bindings_immutable (s : Store) (op id : Nat) (outage lost : Bool) (a : Artifact)
    (h : s.attached id = some a) : (finish s op outage lost).1.attached id = some a := by
  unfold finish
  split <;> try exact h
  split <;> try exact h
  split <;> try exact h
  split <;> try exact h
  exact commit_bindings_immutable _ _ _ _ h

theorem step_bindings_immutable (s : Store) (c : Command) (id : Nat) (a : Artifact)
    (h : s.attached id = some a) : (step s c).1.attached id = some a := by
  cases c <;> simp only [step]
  all_goals try first
    | exact h
    | exact finish_bindings_immutable _ _ _ _ _ _ h
    | (unfold begin; repeat first | split | exact h)
    | (unfold put; repeat first | split | exact h)
    | (unfold start; repeat first | split | exact h)

theorem arbitrary_trace_immutable_binding (s : Store) (commands : List Command)
    (id : Nat) (a : Artifact) (h : s.attached id = some a) :
    (trace s commands).attached id = some a := by
  induction commands generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (step_bindings_immutable s c id a h)

theorem denied_commit_has_no_effect (s : Store) (p : Pending)
    (denied : writable s p.caller = false) : commit s p = (s, "forbidden") := by
  simp [commit, denied]

theorem existing_commit_exact_replay (s : Store) (p : Pending) (a : Artifact)
    (allowed : writable s p.caller = true) (existing : s.attached p.upload = some a) :
    commit s p = (s, "complete") := by simp [commit, allowed, existing]

theorem commit_new_attachment_authorized (s : Store) (p : Pending) (id : Nat)
    (changed : (commit s p).1.attached id ≠ s.attached id) : writable s p.caller = true := by
  cases h : writable s p.caller
  · simp [commit, h] at changed
  · rfl

theorem positive_recovery (s : Store) (op : Nat) (p : Pending) (content : Content)
    (pending : s.pending op = some p) (stored : s.objects p.ticket.project p.ticket.hash = some content)
    (size : content.size = p.ticket.size) (allowed : writable s p.caller = true)
    (absent : s.attached p.upload = none) :
    (finish s op false false).1.attached p.upload = some ⟨s.next, p.ticket⟩ ∧
    (finish s op false false).2 = "complete" := by
  simp [finish, pending, stored, size, commit, allowed, absent, update]

theorem outage_retry_retains_state (s : Store) (op : Nat) (p : Pending)
    (pending : s.pending op = some p) : finish s op true false = (s, "blob_unavailable") := by
  simp [finish, pending]

theorem lost_commit_keeps_persistence (s : Store) (op : Nat) :
    (finish s op false true).1 = (finish s op false false).1 := by
  unfold finish
  repeat first | split | rfl

theorem step_safe (s : Store) (c : Command) (safe : Safe s) : Safe (step s c).1 := by
  rcases safe with ⟨hp, ha, ho⟩
  cases c with
  | grant | revoke | advance => exact ⟨hp, ha, ho⟩
  | restart => exact ⟨(by intro op p h; cases h), ha, ho⟩
  | begin id caller ticket =>
    simp only [step]
    unfold begin
    split <;> try exact ⟨hp, ha, ho⟩
    split <;> try exact ⟨hp, ha, ho⟩
    split <;> try (split <;> exact ⟨hp, ha, ho⟩)
    rename_i absent
    refine ⟨?_, ?_, ho⟩
    · intro op p h
      obtain ⟨ht, own⟩ := hp op p h
      refine ⟨?_, own⟩
      simp only [update]
      split <;> simp_all
    · intro key a h
      obtain ⟨ht, rest⟩ := ha key a h
      refine ⟨?_, rest⟩
      simp only [update]
      split <;> simp_all
  | put project hash content lost =>
    simp only [step]
    unfold put
    split <;> try exact ⟨hp, ha, ho⟩
    rename_i verified
    split <;> try exact ⟨hp, ha, ho⟩
    rename_i absent
    refine ⟨hp, ?_, ?_⟩
    · intro id a h
      obtain ⟨ht, old, found, token, size⟩ := ha id a h
      refine ⟨ht, old, ?_, token, size⟩
      dsimp
      split <;> simp_all
    · intro p h value found
      dsimp at found
      split at found
      · rename_i address; cases found; simp_all
      · exact ho p h value found
  | start op id caller =>
    simp only [step]
    unfold start
    split <;> try exact ⟨hp, ha, ho⟩
    split <;> try exact ⟨hp, ha, ho⟩
    rename_i ticket found
    split <;> try exact ⟨hp, ha, ho⟩
    rename_i own
    split <;> try exact ⟨hp, ha, ho⟩
    refine ⟨?_, ha, ho⟩
    intro key p h
    simp only [update] at h
    split at h
    · cases h; exact ⟨found, by simpa using own⟩
    · exact hp key p h
  | finish op outage lost =>
    simp only [step]
    unfold finish
    split <;> try exact ⟨hp, ha, ho⟩
    rename_i p pending
    split <;> try exact ⟨hp, ha, ho⟩
    split <;> try exact ⟨hp, ha, ho⟩
    rename_i content stored
    split <;> try exact ⟨hp, ha, ho⟩
    rename_i size
    dsimp
    unfold commit
    split <;> try exact ⟨hp, ha, ho⟩
    split <;> try exact ⟨hp, ha, ho⟩
    refine ⟨hp, ?_, ho⟩
    intro id a h
    simp only [update] at h
    split at h
    · rename_i same; cases h
      exact ⟨same ▸ (hp op p pending).1, content, stored, ho _ _ _ stored, by simpa using size⟩
    · exact ha id a h

theorem arbitrary_trace_content_and_project_binding (commands : List Command) :
    Safe (trace {} commands) := by
  have general : ∀ s, Safe s → Safe (trace s commands) := by
    induction commands with
    | nil => intro s h; exact h
    | cons c cs ih => intro s h; exact ih _ (step_safe s c h)
  exact general {} initial_safe

-- An old object cannot be changed by any admitted command (including duplicate PUTs).
theorem step_objects_immutable (s : Store) (c : Command) (project : Nat) (hash : String)
    (content : Content) (h : s.objects project hash = some content) :
    (step s c).1.objects project hash = some content := by
  cases c <;> simp only [step]
  all_goals try first
    | exact h
    | (unfold begin; repeat first | split | exact h)
    | (unfold start; repeat first | split | exact h)
    | (unfold finish; repeat first | split | exact h | (unfold commit))
  unfold put
  split <;> try exact h
  split <;> try exact h
  rename_i absent
  dsimp
  split
  · rename_i same; simp_all
  · exact h

theorem arbitrary_trace_immutable_object (s : Store) (commands : List Command)
    (project : Nat) (hash : String) (content : Content)
    (h : s.objects project hash = some content) :
    (trace s commands).objects project hash = some content := by
  induction commands generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (step_objects_immutable s c project hash content h)

theorem step_tickets_immutable (s : Store) (c : Command) (id : Nat) (ticket : Ticket)
    (h : s.tickets id = some ticket) : (step s c).1.tickets id = some ticket := by
  cases c <;> simp only [step]
  all_goals try first
    | exact h
    | exact begin_tickets_immutable _ _ _ _ _ _ h
    | (unfold put; repeat first | split | exact h)
    | (unfold start; repeat first | split | exact h)
    | (unfold finish; repeat first | split | exact h | (unfold commit))

theorem arbitrary_trace_immutable_ticket (s : Store) (commands : List Command)
    (id : Nat) (ticket : Ticket) (h : s.tickets id = some ticket) :
    (trace s commands).tickets id = some ticket := by
  induction commands generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (step_tickets_immutable s c id ticket h)

theorem commit_changes_only_target (s : Store) (p : Pending) (id : Nat)
    (changed : (commit s p).1.attached id ≠ s.attached id) : p.upload = id := by
  unfold commit at changed
  split at changed <;> try exact False.elim (changed rfl)
  split at changed <;> try exact False.elim (changed rfl)
  simp only [update] at changed
  split at changed
  · rename_i same; exact same.symm
  · exact False.elim (changed rfl)

theorem start_completed_exact_replay (s : Store) (op id : Nat) (c : Caller)
    (ticket : Ticket) (a : Artifact) (allowed : writable s c = true)
    (found : s.tickets id = some ticket) (own : owns c ticket = true)
    (retained : s.attached id = some a) : start s op id c = (s, "complete") := by
  simp [start, allowed, found, own, retained]

theorem step_attachment_authorized (s : Store) (c : Command) (id : Nat) (safe : Safe s)
    (changed : (step s c).1.attached id ≠ s.attached id) :
    ∃ p : Pending, p.upload = id ∧ writable s p.caller = true ∧ owns p.caller p.ticket = true ∧
      s.tickets p.upload = some p.ticket := by
  cases c <;> simp only [step] at changed
  all_goals try first
    | exact False.elim (changed rfl)
    | (unfold begin at changed; repeat first | split at changed | exact False.elim (changed rfl))
    | (unfold put at changed; repeat first | split at changed | exact False.elim (changed rfl))
    | (unfold start at changed; repeat first | split at changed | exact False.elim (changed rfl))
  unfold finish at changed
  split at changed <;> try exact False.elim (changed rfl)
  rename_i p pending
  split at changed <;> try exact False.elim (changed rfl)
  split at changed <;> try exact False.elim (changed rfl)
  split at changed <;> try exact False.elim (changed rfl)
  exact ⟨p, commit_changes_only_target s p id changed, commit_new_attachment_authorized s p id changed,
    (safe.1 _ _ pending).2, (safe.1 _ _ pending).1⟩

theorem arbitrary_trace_no_unauthorized_attachment (commands : List Command) (c : Command)
    (id : Nat) (changed : (step (trace {} commands) c).1.attached id ≠
      (trace {} commands).attached id) :
    ∃ p : Pending, p.upload = id ∧ writable (trace {} commands) p.caller = true ∧ owns p.caller p.ticket = true ∧
      (trace {} commands).tickets p.upload = some p.ticket :=
  step_attachment_authorized _ _ _ (arbitrary_trace_content_and_project_binding commands) changed

def exampleTicket : Ticket := ⟨1, 1, "bytes", 5, "file", "text/plain"⟩
def examplePending : Pending := ⟨1, ⟨1, 1, none⟩, exampleTicket⟩
def revokedStore : Store :=
  { authority := { actors := [⟨1, 1, .producer⟩], revokedActors := [1] },
    tickets := update (fun _ => none) 1 (some exampleTicket),
    objects := fun p h => if p = 1 ∧ h = "bytes" then some ⟨"bytes", 5⟩ else none,
    pending := update (fun _ => none) 1 (some examplePending) }

def staleCommit (s : Store) (p : Pending) : Store :=
  { s with attached := update s.attached p.upload (some ⟨s.next, p.ticket⟩) }

theorem stale_authorization_counterexample :
    writable revokedStore examplePending.caller = false ∧
    (finish revokedStore 1 false false).1.attached 1 = none ∧
    (staleCommit revokedStore examplePending).attached 1 ≠ none := by decide

-- Already-issued URLs do not consult Scope at redemption.
def capabilityValid (now expires : Nat) : Bool := now < expires

theorem revocation_does_not_revoke_capability :
    writable revokedStore examplePending.caller = false ∧ capabilityValid 5 60 = true := by decide

theorem capability_expiry (now expires : Nat) (expired : expires ≤ now) :
    capabilityValid now expires = false := by simp [capabilityValid]; omega
end Merv.BackendStorage
