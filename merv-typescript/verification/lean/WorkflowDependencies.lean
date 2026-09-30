import Std

/-!
Independent finite-graph oracle for dependency safety. Admission searches finite
rank assignments rather than copying PostgreSQL's recursive reachability query.
A successful rank certificate proves absence of *any* nonempty cycle. Completeness
of the rank search is not a claimed theorem; differential tests check accepted and
refused graphs against the service. The fixed node universe is the fixture's set of
existing tenant-local instances; target success contracts are pinned to `done`.
-/
namespace Merv.WorkflowDependencies

structure Edge where
  source : Nat
  target : Nat
  owner : Nat := 0 -- zero is declared; positive values are system providers
  deriving Repr, BEq, DecidableEq, Inhabited

inductive Path (edges : List Edge) : Nat → Nat → Prop where
  | edge (e : Edge) (member : e ∈ edges) : Path edges e.source e.target
  | trans {a b c : Nat} : Path edges a b → Path edges b c → Path edges a c

def Acyclic (edges : List Edge) : Prop := ∀ node, ¬ Path edges node node

def rank (values : List Nat) (node : Nat) : Nat := values[node]?.getD 0

def ordered (edges : List Edge) (values : List Nat) : Bool :=
  edges.all fun e => decide (rank values e.source < rank values e.target)

-- All n^n assignments with values in [0,n). Unlike an implementation-shaped DFS,
-- this is a small exhaustive oracle, practical for the four-node conformance world.
def vectors (bound : Nat) : Nat → List (List Nat)
  | 0 => [[]]
  | count + 1 => (List.range bound).flatMap fun value =>
      (vectors bound count).map (value :: ·)

def certified (nodes : Nat) (edges : List Edge) : Bool :=
  (vectors nodes nodes).any (ordered edges)

theorem ordered_path (edges : List Edge) (values : List Nat)
    (good : ordered edges values = true) {a b : Nat} (path : Path edges a b) :
    rank values a < rank values b := by
  induction path with
  | edge e member =>
      have all := List.all_eq_true.mp good e member
      exact of_decide_eq_true all
  | trans _ _ first second => exact Nat.lt_trans first second

theorem certified_acyclic (nodes : Nat) (edges : List Edge)
    (success : certified nodes edges = true) : Acyclic edges := by
  obtain ⟨values, _, good⟩ := List.any_eq_true.mp success
  intro node cycle
  exact Nat.lt_irrefl _ (ordered_path edges values good cycle)

theorem path_subset {before after : List Edge}
    (subset : ∀ e ∈ after, e ∈ before) {a b : Nat} (path : Path after a b) :
    Path before a b := by
  induction path with
  | edge e member => exact .edge e (subset e member)
  | trans _ _ first second => exact .trans first second

theorem removal_preserves_acyclic (edges : List Edge) (keep : Edge → Bool)
    (acyclic : Acyclic edges) : Acyclic (edges.filter keep) := by
  intro node path
  exact acyclic node (path_subset (fun _ h => (List.mem_filter.mp h).1) path)

structure Store where
  nodes : Nat
  edges : List Edge := []
  done : List Nat := []
  failed : List Nat := []
  revisions : List (Nat × Nat) := []
  deriving Repr, Inhabited

def revision (s : Store) (node : Nat) : Nat :=
  ((s.revisions.find? (fun p => p.1 == node)).map Prod.snd).getD 0

def gated (s : Store) (node : Nat) : Bool :=
  s.edges.all fun e => decide (e.source ≠ node ∨ e.target ∈ s.done)

def gateError (s : Store) (node : Nat) : String :=
  if s.edges.any (fun e => decide (e.source = node ∧ e.owner = 0 ∧ e.target ∈ s.failed))
  then "dependency_failed" else "dependencies_pending"

def ended (s : Store) (node : Nat) : Bool := decide (node ∈ s.done ∨ node ∈ s.failed)
def bumped (s : Store) (node : Nat) : List (Nat × Nat) :=
  (node, revision s node + 1) :: s.revisions

def extend (s : Store) (source owner : Nat) (targets : List Nat) : List Edge :=
  s.edges ++ (targets.eraseDups.map (fun target => Edge.mk source target owner)).filter
    (fun (e : Edge) => !s.edges.contains e)

inductive Command where
  | add (source : Nat) (targets : List Nat)
  | drop (source : Nat) (targets : List Nat)
  | replace (source owner : Nat) (targets : List Nat)
  | finish (node : Nat)
  | fail (node : Nat)
  | gate (node : Nat)
  deriving Repr, Inhabited

structure Result where
  store : Store
  outcome : String
  deriving Repr, Inhabited

def unchanged (s : Store) (outcome : String) : Result := ⟨s, outcome⟩

def step (s : Store) : Command → Result
  | .add source targets =>
      if ended s source then unchanged s "invalid_transition"
      else if targets.any (fun t => decide (s.nodes ≤ t)) then unchanged s "not_found"
      else
        let edges := extend s source 0 targets
        if certified s.nodes edges then
          ⟨{ s with edges := edges, revisions := (if edges = s.edges then s.revisions else bumped s source) }, "added"⟩
        else unchanged s "dependency_cycle"
  | .drop source targets =>
      if ended s source then unchanged s "invalid_transition"
      else
        let edges := s.edges.filter fun e =>
          decide (¬ (e.source = source ∧ e.owner = 0 ∧ e.target ∈ targets))
        ⟨{ s with edges := edges, revisions := (if edges = s.edges then s.revisions else bumped s source) }, "dropped"⟩
  | .replace source owner targets =>
      if targets.any (fun t => decide (s.nodes ≤ t)) then unchanged s "not_found"
      else
        let edges := (extend s source owner targets).filter fun e =>
          decide (e.source ≠ source ∨ e.owner ≠ owner ∨ e.target ∈ targets)
        if certified s.nodes edges then ⟨{ s with edges }, "replaced"⟩
        else unchanged s "dependency_cycle"
  | .finish node =>
      if ended s node then unchanged s "invalid_transition"
      else if gated s node then
        ⟨{ s with done := node :: s.done, revisions := bumped s node }, "done"⟩
      else unchanged s (gateError s node)
  | .fail node =>
      if ended s node then unchanged s "invalid_transition"
      else ⟨{ s with failed := node :: s.failed, revisions := bumped s node }, "failed"⟩
  | .gate node =>
      if gated s node then unchanged s "ready" else unchanged s (gateError s node)

theorem step_preserves_acyclic (s : Store) (c : Command) (h : Acyclic s.edges) :
    Acyclic (step s c).store.edges := by
  cases c <;> simp only [step]
  all_goals repeat (first | split | exact h |
    exact certified_acyclic _ _ (by assumption) |
    exact removal_preserves_acyclic _ _ h)

def trace (s : Store) (commands : List Command) : Store :=
  commands.foldl (fun s c => (step s c).store) s

theorem trace_preserves_acyclic (s : Store) (commands : List Command)
    (h : Acyclic s.edges) : Acyclic (trace s commands).edges := by
  induction commands generalizing s with
  | nil => exact h
  | cons c cs ih => exact ih _ (step_preserves_acyclic s c h)

theorem gated_requires_all_settled (s : Store) (node : Nat) (ready : gated s node = true)
    (e : Edge) (member : e ∈ s.edges) (source : e.source = node) : e.target ∈ s.done := by
  have h := List.all_eq_true.mp ready e member
  have valid := of_decide_eq_true h
  exact valid.resolve_left (by simp [source])

theorem finish_requires_all_settled (s : Store) (node : Nat)
    (success : (step s (.finish node)).outcome = "done") :
    ∀ e ∈ s.edges, e.source = node → e.target ∈ s.done := by
  simp only [step] at success
  split at success
  · simp [unchanged] at success
  · split at success
    · exact gated_requires_all_settled s node (by assumption)
    · simp [unchanged, gateError] at success
      split at success <;> contradiction

theorem terminal_preserved (s : Store) (c : Command) (node : Nat)
    (terminal : node ∈ s.done ∨ node ∈ s.failed) :
    node ∈ (step s c).store.done ∨ node ∈ (step s c).store.failed := by
  cases c <;> simp only [step]
  all_goals repeat (first | split | simp_all [unchanged])
  all_goals rcases terminal with h | h <;> simp_all [unchanged]

theorem no_op_add_keeps_revision (s : Store) (source : Nat) (targets : List Nat)
    (same : extend s source 0 targets = s.edges) :
    (step s (.add source targets)).store.revisions = s.revisions := by
  simp only [step]
  repeat (first | split | simp_all [unchanged])

end Merv.WorkflowDependencies
