import IdentityCredentials
import ScopeAuthority
import SessionOwnership

/-! Composed dispatch authority from raw current records. Catalog replacement drains admitted
handlers; session-provider replacement invalidates pending decisions. Effects are dispatches,
not claims about remote commits. No record contains an authorization proof or supplied bit. -/
namespace Merv.BackendAuthority

structure Credential where
  id : Nat
  project : Nat
  actor : Nat
  deriving BEq, DecidableEq, Repr
structure Link where
  session : Nat
  project : Nat
  actor : Nat
  sourceActor : Nat
  credential : Nat
  member : Option ScopeAuthority.Source := none
  deriving BEq, DecidableEq, Repr
structure Request where
  project : Nat
  actor : Nat
  credential : Nat := 0
  session : Option Nat := none
  deriving BEq, DecidableEq, Repr
structure Tool where
  generation : Nat
  mount : Nat
  name : Nat
  deriving BEq, DecidableEq, Repr
structure Grant where
  project : Nat
  actor : Nat
  mount : Nat
  tool : Nat
  deriving BEq, DecidableEq, Repr
structure Binding where
  project : Nat
  actor : Nat
  mount : Nat
  upstream : Nat
  deriving BEq, DecidableEq, Repr
structure World where
  credentials : IdentityCredentials.Store := {}
  credentialBindings : List Credential := []
  scope : ScopeAuthority.Store := {}
  sessions : SessionOwnership.Store := {}
  links : List Link := []
  provider : Nat := 0
  installed : Bool := true
  catalog : List Tool := []
  grants : List Grant := []
  bindings : List Binding := []
structure Prepared where
  id : Nat
  request : Request
  provider : Nat
  execution : Nat
  tool : Tool
  bindings : List Binding
  deriving BEq, DecidableEq, Repr

def credentialLive (w : World) (project actor credential : Nat) : Bool :=
  w.credentialBindings.any (fun c => c.id == credential && c.project == project && c.actor == actor) &&
  (w.credentials.rows credential).any (fun r =>
    r.identity.owner == 1 && r.identity.subject == credential && r.identity.kind == 1 &&
    IdentityCredentials.live w.credentials.time r)

def sessionCredentialLive (w : World) (session : Nat) : Bool :=
  (w.credentials.rows session).any (fun r =>
    r.identity.owner == 2 && r.identity.subject == session && r.identity.kind == 2 &&
    IdentityCredentials.live w.credentials.time r)

def sourceLive (w : World) (l : Link) : Bool :=
  match l.member with
  | some src => src.epoch == l.sourceActor && src.project == l.project && ScopeAuthority.delegated w.scope src .write
  | none => credentialLive w l.project l.sourceActor l.credential &&
      ScopeAuthority.actorAuthority w.scope l.sourceActor l.project .write

-- Effective owner comes from current links, not caller-supplied delegation fields.
def holder (w : World) (q : Request) : Option Nat :=
  match q.session with
  | none => if credentialLive w q.project q.actor q.credential &&
      ScopeAuthority.actorAuthority w.scope q.actor q.project .read then some q.actor else none
  | some id =>
      match w.links.find? (fun l => l.session == id), SessionOwnership.row w.sessions id with
      | some l, some r =>
          if q.credential == 0 && l.project == q.project && l.actor == q.actor &&
            r.actor == q.actor && sourceLive w l && SessionOwnership.usable w.sessions r && sessionCredentialLive w id
          then some l.sourceActor else none
      | _, _ => none

def generationLive (w : World) (p : Prepared) : Bool :=
  match p.request.session with
  | none => true
  | some _ => w.installed && w.provider == p.provider && w.sessions.installed &&
      w.sessions.generation == p.execution

def bindingFor (w : World) (p : Prepared) : Option Binding :=
  match holder w p.request with
  | none => none
  | some actor =>
      if !w.grants.any (fun g => g.project == p.request.project && g.actor == actor &&
          g.mount == p.tool.mount && g.tool == p.tool.name) then none
      else p.bindings.find? (fun b => b.project == p.request.project && b.actor == actor && b.mount == p.tool.mount)

def authorized (w : World) (p : Prepared) (presented : Request) : Bool :=
  decide (presented = p.request) && generationLive w p && (bindingFor w p).isSome

-- Admission-time worlds are raw audit observations. Later revocation does not erase a dispatch.
structure Effect where
  world : World
  prepared : Prepared
  presented : Request
  upstream : Nat
structure Store where
  world : World := {}
  pending : List Prepared := []
  used : List Nat := []
  effects : List Effect := []
inductive Change where
  | credential (hash : Nat) (operation : IdentityCredentials.Operation)
  | scope (command : ScopeAuthority.Command)
  | session (command : SessionOwnership.Command)
  | advance (time : Nat)
  | provider (installed : Bool)
  | catalog (tools : List Tool)
  | grants (grants : List Grant)
  | bindings (bindings : List Binding)

def change (w : World) : Change → World
  | .credential hash op => { w with credentials := IdentityCredentials.step w.credentials (.at hash op) }
  | .scope c => { w with scope := ScopeAuthority.step w.scope c }
  | .session c => { w with sessions := (SessionOwnership.step w.sessions c).store }
  | .advance time => { w with credentials := { w.credentials with time := time }, scope := { w.scope with time := time }, sessions := { w.sessions with time := time } }
  | .provider installed => { w with provider := w.provider + 1, installed := installed }
  | .catalog tools => { w with catalog := tools }
  | .grants grants => { w with grants := grants }
  | .bindings bindings => { w with bindings := bindings }
inductive Command where
  | alter (change : Change)
  | prepare (id : Nat) (request : Request) (mount tool : Nat)
  | dispatch (id : Nat) (presented : Request)
  | cancel (id : Nat)
structure Result where
  store : Store
  outcome : String

def dispatch (s : Store) (id : Nat) (presented : Request) : Result :=
  let consumed := { s with used := id :: s.used }
  if id ∈ s.used then ⟨s, "denied"⟩ else
  match s.pending.find? (fun p => p.id == id) with
  | none => ⟨s, "denied"⟩
  | some p =>
      if authorized s.world p presented then
        match bindingFor s.world p with
        | none => ⟨consumed, "denied"⟩
        | some b => ⟨{ consumed with effects := ⟨s.world, p, presented, b.upstream⟩ :: s.effects }, "effect"⟩
      else ⟨consumed, "denied"⟩

def step (s : Store) : Command → Result
  | .alter c => ⟨{ s with world := change s.world c }, "changed"⟩
  | .cancel id => ⟨{ s with used := id :: s.used }, "cancelled"⟩
  | .dispatch id q => dispatch s id q
  | .prepare id q mount name =>
      if s.pending.any (fun p => p.id == id) || decide (id ∈ s.used) then ⟨s, "denied"⟩ else
      match s.world.catalog.find? (fun t => t.mount == mount && t.name == name) with
      | none => ⟨s, "denied"⟩
      | some tool =>
          let p : Prepared := ⟨id, q, s.world.provider, s.world.sessions.generation, tool, s.world.bindings⟩
          if authorized s.world p q then ⟨{ s with pending := p :: s.pending }, "prepared"⟩
          else ⟨s, "denied"⟩

def trace (s : Store) (cs : List Command) : Store := cs.foldl (fun s c => (step s c).store) s

def Safe (s : Store) : Prop := ∀ e ∈ s.effects,
  e.presented = e.prepared.request ∧ generationLive e.world e.prepared = true ∧
  ∃ b, bindingFor e.world e.prepared = some b ∧ b.upstream = e.upstream

theorem dispatch_safe (s : Store) (id : Nat) (q : Request) (safe : Safe s) :
    Safe (dispatch s id q).store := by
  simp only [dispatch]
  split
  · exact safe
  · split
    · exact safe
    · split
      · rename_i p found auth
        split
        · exact safe
        · rename_i b bound
          intro e he
          simp only [List.mem_cons] at he
          rcases he with rfl | old
          · have h := auth
            simp only [authorized, Bool.and_eq_true, decide_eq_true_eq] at h
            exact ⟨h.1.1, h.1.2, b, bound, rfl⟩
          · exact safe e old
      · exact safe

theorem step_safe (s : Store) (c : Command) (safe : Safe s) : Safe (step s c).store := by
  cases c with
  | alter _ => exact safe
  | cancel _ => exact safe
  | dispatch id q => exact dispatch_safe s id q safe
  | prepare id q mount name =>
      simp only [step]
      split
      · exact safe
      · split
        · exact safe
        · split <;> exact safe

theorem arbitrary_trace_dispatch_safety (s : Store) (cs : List Command) (safe : Safe s) :
    Safe (trace s cs) := by
  induction cs generalizing s with
  | nil => exact safe
  | cons c cs ih => exact ih _ (step_safe s c safe)

theorem empty_trace_dispatch_safety (w : World) (cs : List Command) :
    Safe (trace { world := w } cs) :=
  arbitrary_trace_dispatch_safety _ _ (by intro e h; cases h)

-- Derive concrete relational facts instead of asserting an opaque permission predicate.
theorem binding_requires_exact_holder_grant (w : World) (p : Prepared) (b : Binding)
    (h : bindingFor w p = some b) :
    ∃ actor, holder w p.request = some actor ∧ b ∈ p.bindings ∧
      b.project = p.request.project ∧ b.actor = actor ∧ b.mount = p.tool.mount ∧
      ∃ g ∈ w.grants, g.project = p.request.project ∧ g.actor = actor ∧
        g.mount = p.tool.mount ∧ g.tool = p.tool.name := by
  cases hh : holder w p.request with
  | none => simp [bindingFor, hh] at h
  | some actor =>
    simp only [bindingFor, hh] at h
    split at h
    · cases h
    · rename_i grant
      have hb := List.find?_some h
      have hg : ∃ g ∈ w.grants, g.project = p.request.project ∧ g.actor = actor ∧
          g.mount = p.tool.mount ∧ g.tool = p.tool.name := by
        simpa [List.any_eq_true, Bool.and_eq_true, and_assoc] using grant
      simp only [Bool.and_eq_true, beq_iff_eq] at hb
      exact ⟨actor, rfl, List.mem_of_find?_eq_some h, hb.1.1, hb.1.2, hb.2, hg⟩

theorem credential_requires_live_exact_record (w : World) (project actor id : Nat)
    (h : credentialLive w project actor id = true) :
    (∃ c ∈ w.credentialBindings, c.id = id ∧ c.project = project ∧ c.actor = actor) ∧
    ∃ r, w.credentials.rows id = some r ∧ r.identity.owner = 1 ∧
      r.identity.subject = id ∧ r.identity.kind = 1 ∧ IdentityCredentials.live w.credentials.time r = true := by
  simpa [credentialLive, Option.any_eq_true, and_assoc] using h

theorem session_holder_requires_current_records (w : World) (q : Request) (id actor : Nat)
    (hs : q.session = some id) (h : holder w q = some actor) :
    ∃ l r, w.links.find? (fun l => l.session == id) = some l ∧
      SessionOwnership.row w.sessions id = some r ∧ q.credential = 0 ∧
      l.project = q.project ∧ l.actor = q.actor ∧ r.actor = q.actor ∧
      sourceLive w l = true ∧ SessionOwnership.usable w.sessions r = true ∧
      sessionCredentialLive w id = true ∧ actor = l.sourceActor := by
  simp only [holder, hs] at h
  split at h
  · rename_i l r hl hr
    split at h
    · rename_i auth
      simp only [Bool.and_eq_true, beq_iff_eq] at auth
      cases h
      refine ⟨l, r, hl, hr, ?_⟩
      simpa only [and_assoc] using And.intro auth (Eq.refl l.sourceActor)
    · cases h
  · cases h

theorem source_live_requires_exact_source (w : World) (l : Link) (h : sourceLive w l = true) :
    (∃ src, l.member = some src ∧ src.epoch = l.sourceActor ∧ src.project = l.project ∧
      ScopeAuthority.delegated w.scope src .write = true) ∨
    (l.member = none ∧ credentialLive w l.project l.sourceActor l.credential = true ∧
      ScopeAuthority.actorAuthority w.scope l.sourceActor l.project .write = true) := by
  cases hm : l.member with
  | none =>
    right
    simpa [sourceLive, hm] using h
  | some src =>
    left
    refine ⟨src, rfl, ?_⟩
    simpa [sourceLive, hm, and_assoc] using h

theorem retired_member_blocks_source (w : World) (l : Link) (src : ScopeAuthority.Source)
    (bound : l.member = some src) (retired : src.epoch ∈ w.scope.retired) :
    sourceLive w l = false := by
  simp [sourceLive, bound, ScopeAuthority.retired_source_denied w.scope src .write retired]

theorem arbitrary_scope_trace_cannot_resurrect_source (w : World) (l : Link)
    (src : ScopeAuthority.Source) (cs : List ScopeAuthority.Command)
    (bound : l.member = some src) (retired : src.epoch ∈ w.scope.retired) :
    sourceLive { w with scope := ScopeAuthority.trace w.scope cs } l = false := by
  apply retired_member_blocks_source _ l src bound
  exact ScopeAuthority.trace_retired _ _ _ retired

theorem wrong_identity_denied (w : World) (p : Prepared) (q : Request)
    (wrong : q ≠ p.request) : authorized w p q = false := by
  simp [authorized, wrong]

theorem provider_replacement_denied (w : World) (p : Prepared) (id : Nat)
    (hs : p.request.session = some id) (captured : p.provider = w.provider) (installed : Bool) :
    authorized (change w (.provider installed)) p p.request = false := by
  simp [authorized, generationLive, hs, change, captured]

theorem one_shot_dispatch (s : Store) (id : Nat) (q : Request) (used : id ∈ s.used) :
    dispatch s id q = ⟨s, "denied"⟩ := by simp [dispatch, used]

theorem authorized_dispatch_progress (s : Store) (id : Nat) (q : Request) (p : Prepared)
    (fresh : id ∉ s.used) (found : s.pending.find? (fun p => p.id == id) = some p)
    (auth : authorized s.world p q = true) :
    (dispatch s id q).outcome = "effect" ∧
    (dispatch s id q).store.effects.length = s.effects.length + 1 := by
  have bound : (bindingFor s.world p).isSome = true := by
    simp only [authorized, Bool.and_eq_true] at auth
    exact auth.2
  cases hb : bindingFor s.world p with
  | none => simp [hb] at bound
  | some b => simp [dispatch, fresh, found, auth, hb]

theorem catalog_replacement_preserves_admitted_authority (w : World) (p : Prepared)
    (q : Request) (tools : List Tool) :
    authorized (change w (.catalog tools)) p q = authorized w p q := rfl

-- Mount bindings are fixed for one load, like its handler; reloads cannot retarget a pending
-- old handler to the successor's credentials. Current Scope authority/grants still co-decide.
theorem binding_replacement_preserves_admitted_selection (w : World) (p : Prepared)
    (q : Request) (bindings : List Binding) :
    authorized (change w (.bindings bindings)) p q = authorized w p q := rfl

-- Authority-record invariants survive every interleaving, including failed dispatches.
theorem dispatch_world (s : Store) (id : Nat) (q : Request) :
    (dispatch s id q).store.world = s.world := by
  simp only [dispatch]
  repeat (first | split | rfl)

theorem step_world (s : Store) (c : Command) :
    (step s c).store.world = match c with
      | .alter ch => change s.world ch
      | _ => s.world := by
  cases c with
  | alter _ => rfl
  | cancel _ => rfl
  | dispatch id q => exact dispatch_world s id q
  | prepare id q mount name =>
    simp only [step]
    repeat (first | split | rfl)

theorem change_preserves_retired (w : World) (c : Change) (epoch : Nat)
    (h : epoch ∈ w.scope.retired) : epoch ∈ (change w c).scope.retired := by
  cases c with
  | scope c => exact ScopeAuthority.step_retired w.scope c epoch h
  | credential _ _ | session _ | advance _ | provider _ | catalog _ | grants _ | bindings _ => exact h

theorem trace_preserves_retired (s : Store) (cs : List Command) (epoch : Nat)
    (h : epoch ∈ s.world.scope.retired) : epoch ∈ (trace s cs).world.scope.retired := by
  induction cs generalizing s with
  | nil => exact h
  | cons c cs ih =>
    apply ih
    rw [step_world]
    cases c with
    | alter ch => exact change_preserves_retired s.world ch epoch h
    | prepare _ _ _ _ | dispatch _ _ | cancel _ => exact h

theorem arbitrary_composed_trace_cannot_resurrect_source (s : Store) (cs : List Command)
    (l : Link) (src : ScopeAuthority.Source) (bound : l.member = some src)
    (retired : src.epoch ∈ s.world.scope.retired) :
    sourceLive (trace s cs).world l = false :=
  retired_member_blocks_source _ l src bound (trace_preserves_retired s cs src.epoch retired)

theorem change_retains_credential (w : World) (c : Change) (key : Nat)
    (r : IdentityCredentials.Row) (found : w.credentials.rows key = some r) :
    ∃ next, (change w c).credentials.rows key = some next ∧ IdentityCredentials.Retains r next := by
  cases c with
  | credential hash op => exact IdentityCredentials.step_retains w.credentials (.at hash op) key r found
  | scope _ | session _ | advance _ | provider _ | catalog _ | grants _ | bindings _ =>
    exact ⟨r, found, IdentityCredentials.retains_refl r⟩

theorem trace_retains_credential (s : Store) (cs : List Command) (key : Nat)
    (r : IdentityCredentials.Row) (found : s.world.credentials.rows key = some r) :
    ∃ next, (trace s cs).world.credentials.rows key = some next ∧ IdentityCredentials.Retains r next := by
  induction cs generalizing s r with
  | nil => exact ⟨r, found, IdentityCredentials.retains_refl r⟩
  | cons c cs ih =>
    have one : ∃ next, (step s c).store.world.credentials.rows key = some next ∧
        IdentityCredentials.Retains r next := by
      rw [step_world]
      cases c with
      | alter ch => exact change_retains_credential s.world ch key r found
      | prepare _ _ _ _ | dispatch _ _ | cancel _ => exact ⟨r, found, IdentityCredentials.retains_refl r⟩
    obtain ⟨middle, hm, hr⟩ := one
    obtain ⟨last, hl, hm'⟩ := ih _ middle hm
    exact ⟨last, hl, IdentityCredentials.retains_trans r middle last hr hm'⟩

theorem arbitrary_composed_trace_cannot_revive_credential (s : Store) (cs : List Command)
    (key project actor : Nat) (r : IdentityCredentials.Row)
    (found : s.world.credentials.rows key = some r) (revoked : r.revoked ≠ none) :
    credentialLive (trace s cs).world project actor key = false := by
  obtain ⟨next, hn, hr⟩ := trace_retains_credential s cs key r found
  have eq := hr.2.2 revoked
  subst next
  cases hrev : r.revoked <;> simp_all [credentialLive, IdentityCredentials.live]

theorem arbitrary_trace_execution_credential_revocation (s : Store) (cs : List Command)
    (id : Nat) (r : IdentityCredentials.Row)
    (found : s.world.credentials.rows id = some r) (revoked : r.revoked ≠ none) :
    sessionCredentialLive (trace s cs).world id = false := by
  obtain ⟨next, hn, hr⟩ := trace_retains_credential s cs id r found
  have eq := hr.2.2 revoked
  subst next
  cases hrev : r.revoked <;> simp_all [sessionCredentialLive, IdentityCredentials.live]

theorem fresh_prepare_then_dispatch_progress (s : Store) (p : Prepared)
    (fresh : s.pending.any (fun q => q.id == p.id) = false) (unused : p.id ∉ s.used)
    (tool : s.world.catalog.find? (fun t => t.mount == p.tool.mount && t.name == p.tool.name) = some p.tool)
    (provider : p.provider = s.world.provider) (execution : p.execution = s.world.sessions.generation)
    (bindings : p.bindings = s.world.bindings)
    (auth : authorized s.world p p.request = true) :
    (step (step s (.prepare p.id p.request p.tool.mount p.tool.name)).store
      (.dispatch p.id p.request)).outcome = "effect" := by
  have captured : (⟨p.id, p.request, s.world.provider, s.world.sessions.generation, p.tool, s.world.bindings⟩ : Prepared) = p := by
    cases p; simp_all
  simp only [step, fresh, unused, decide_false, Bool.or_self, Bool.false_eq_true, ite_false, tool, captured, auth, ite_true]
  have found : (p :: s.pending).find? (fun q => q.id == p.id) = some p := by simp
  exact (authorized_dispatch_progress { s with pending := p :: s.pending } p.id p.request p unused found auth).1

theorem step_preserves_consumed (s : Store) (c : Command) (id : Nat) (h : id ∈ s.used) :
    id ∈ (step s c).store.used := by
  cases c <;> simp only [step, dispatch]
  all_goals repeat (first | split | exact h | exact List.mem_cons_of_mem _ h)

theorem trace_preserves_consumed (s : Store) (cs : List Command) (id : Nat) (h : id ∈ s.used) :
    id ∈ (trace s cs).used := by
  induction cs generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (step_preserves_consumed s c id h)

theorem arbitrary_trace_consumed_cannot_dispatch (s : Store) (cs : List Command)
    (id : Nat) (q : Request) (h : id ∈ s.used) :
    (dispatch (trace s cs) id q).outcome = "denied" := by
  rw [one_shot_dispatch _ id q (trace_preserves_consumed s cs id h)]

theorem change_provider_monotone (w : World) (c : Change) : w.provider ≤ (change w c).provider := by
  cases c <;> simp [change]

theorem trace_provider_monotone (s : Store) (cs : List Command) :
    s.world.provider ≤ (trace s cs).world.provider := by
  induction cs generalizing s with
  | nil => exact Nat.le_refl _
  | cons c cs ih =>
    have one : s.world.provider ≤ (step s c).store.world.provider := by
      rw [step_world]
      cases c with
      | alter ch => exact change_provider_monotone s.world ch
      | prepare _ _ _ _ | dispatch _ _ | cancel _ => exact Nat.le_refl _
    exact Nat.le_trans one (ih _)

theorem arbitrary_trace_retired_provider_cannot_recover (s : Store) (cs : List Command)
    (p : Prepared) (id : Nat) (hs : p.request.session = some id)
    (retired : p.provider < s.world.provider) :
    authorized (trace s cs).world p p.request = false := by
  have monotone := trace_provider_monotone s cs
  have different : (trace s cs).world.provider ≠ p.provider := by omega
  simp [authorized, generationLive, hs, different]

-- Executable counterexample: forgetting the generation fence accepts a retired provider.
def staleProviderMutant (w : World) (p : Prepared) (q : Request) : Bool :=
  decide (q = p.request) && (bindingFor w p).isSome

def initial : World := {
  credentials := { rows := fun id => if id = 1 then some ⟨⟨1, 1, 1, none, 0⟩, none, none⟩ else if id = 10 ∨ id = 11 then some ⟨⟨2, id, 2, some 300000, 0⟩, some 300000, none⟩ else none }
  credentialBindings := [⟨1, 1, 1⟩]
  scope := { actors := [⟨1, 1, .producer⟩] }
  sessions := { rows := [⟨10, 10, 0, 10, 10, 300000, 300000⟩, ⟨11, 11, 0, 11, 11, 300000, 300000⟩] }
  links := [⟨10, 1, 10, 1, 1, none⟩, ⟨11, 1, 11, 1, 1, none⟩]
  catalog := [⟨0, 1, 1⟩]
  grants := [⟨1, 1, 1, 1⟩]
  bindings := [⟨1, 1, 1, 100⟩]
}
def worker : Request := ⟨1, 10, 0, some 10⟩
def initialPrepared : Prepared := ⟨1, worker, 0, 0, ⟨0, 1, 1⟩, initial.bindings⟩

theorem provider_mutant_counterexample :
    authorized (change initial (.provider true)) initialPrepared worker = false ∧
    staleProviderMutant (change initial (.provider true)) initialPrepared worker = true := by decide

theorem reinstall_fresh_request_recovers :
    let s := (step { world := change initial (.provider true) } (.prepare 2 worker 1 1)).store
    (step s (.dispatch 2 worker)).outcome = "effect" := by decide

theorem revoked_credential_counterexample :
    authorized (change initial (.credential 1 (.revoke 1))) initialPrepared worker = false := by decide

theorem expiry_boundary_counterexample :
    authorized (change initial (.advance 300000)) initialPrepared worker = false ∧
    authorized (change initial (.advance 299999)) initialPrepared worker = true := by decide

end Merv.BackendAuthority
