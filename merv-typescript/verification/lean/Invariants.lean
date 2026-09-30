import Workflow

namespace Merv.Workflow

-- Every atomic step either preserves the entire store or advances revision,
-- history, and receipts together. This also covers replay and every refusal.
theorem step_effect_shape (g : Graph) (s : Store) (c : Command) :
    (step g s c).store = s ∨
      ((step g s c).store.current.revision = s.current.revision + 1 ∧
       (step g s c).store.historyLength = s.historyLength + 1 ∧
       (step g s c).store.receipts.length = s.receipts.length + 1 ∧
       ∃ after, (step g s c).outcome = .committed after) := by
  unfold step
  split
  · split <;> exact Or.inl rfl
  · split
    · exact Or.inl rfl
    · split
      · exact Or.inl rfl
      · split
        · exact Or.inl rfl
        · split
          · exact Or.inl rfl
          · right
            simp

theorem step_revision_monotone (g : Graph) (s : Store) (c : Command) :
    s.current.revision ≤ (step g s c).store.current.revision := by
  rcases step_effect_shape g s c with same | advanced
  · simp [same]
  · rw [advanced.1]
    omega

theorem step_history_revision_consistent (g : Graph) (s : Store) (c : Command)
    (consistent : s.historyLength = s.current.revision + 1) :
    (step g s c).store.historyLength = (step g s c).store.current.revision + 1 := by
  rcases step_effect_shape g s c with same | advanced
  · simpa [same] using consistent
  · rw [advanced.1, advanced.2.1, consistent]

theorem step_receipts_history_consistent (g : Graph) (s : Store) (c : Command)
    (consistent : s.receipts.length = s.historyLength) :
    (step g s c).store.receipts.length = (step g s c).store.historyLength := by
  rcases step_effect_shape g s c with same | advanced
  · simpa [same] using consistent
  · rw [advanced.2.1, advanced.2.2.1, consistent]

theorem trace_revision_monotone (g : Graph) (s : Store) (commands : List Command) :
    s.current.revision ≤ (trace g s commands).current.revision := by
  induction commands generalizing s with
  | nil => simp [trace]
  | cons c cs ih =>
      exact Nat.le_trans (step_revision_monotone g s c) (ih (step g s c).store)

theorem trace_history_revision_consistent (g : Graph) (s : Store) (commands : List Command)
    (consistent : s.historyLength = s.current.revision + 1) :
    (trace g s commands).historyLength = (trace g s commands).current.revision + 1 := by
  induction commands generalizing s with
  | nil => simpa [trace] using consistent
  | cons c cs ih =>
      exact ih (step g s c).store (step_history_revision_consistent g s c consistent)

theorem trace_receipts_history_consistent (g : Graph) (s : Store) (commands : List Command)
    (consistent : s.receipts.length = s.historyLength) :
    (trace g s commands).receipts.length = (trace g s commands).historyLength := by
  induction commands generalizing s with
  | nil => simpa [trace] using consistent
  | cons c cs ih =>
      exact ih (step g s c).store (step_receipts_history_consistent g s c consistent)

-- Unlike just asserting that edgeFor succeeds, this connects the chosen edge
-- to the declared graph and the actual source/action of the command.
theorem selected_edge_is_declared (g : Graph) (state action : String) (edge : Edge)
    (selected : edgeFor g state action = some edge) :
    edge ∈ g.edges ∧ edge.fromState = state ∧ edge.action = action := by
  have member := List.mem_of_find?_eq_some selected
  have matched := List.find?_some selected
  exact ⟨member, by simpa using matched⟩

-- Merv's validator, rather than an explicit terminal branch, enforces this
-- property. It justifies the core model's explicit terminal refusal.
theorem validated_terminal_has_no_edge (g : Graph) (state action : String)
    (terminal : state ∈ g.terminal)
    (noOutgoing : ∀ edge ∈ g.edges, edge.fromState ∉ g.terminal) :
    edgeFor g state action = none := by
  cases selected : edgeFor g state action with
  | none => rfl
  | some edge =>
      have facts := selected_edge_is_declared g state action edge selected
      have contradiction := noOutgoing edge facts.1
      rw [facts.2.1] at contradiction
      exact False.elim (contradiction terminal)

theorem step_state_declared (g : Graph) (states : List String) (s : Store) (c : Command)
    (current : s.current.state ∈ states)
    (closed : ∀ edge ∈ g.edges, edge.toState ∈ states) :
    (step g s c).store.current.state ∈ states := by
  rcases step_effect_shape g s c with same | advanced
  · simpa [same] using current
  · obtain ⟨after, committed⟩ := advanced.2.2.2
    obtain ⟨edge, selected, target, _, _⟩ := commit_uses_allowed_edge g s c after committed
    have targetDeclared := closed edge (selected_edge_is_declared g _ _ edge selected).1
    unfold step at committed ⊢
    split at committed
    · split at committed <;> cases committed
    · split at committed
      · cases committed
      · split at committed
        · cases committed
        · split at committed
          · cases committed
          · split at committed
            · cases committed
            · cases committed
              simp_all

theorem trace_state_declared (g : Graph) (states : List String) (s : Store)
    (commands : List Command) (current : s.current.state ∈ states)
    (closed : ∀ edge ∈ g.edges, edge.toState ∈ states) :
    (trace g s commands).current.state ∈ states := by
  induction commands generalizing s with
  | nil => simpa [trace] using current
  | cons c cs ih => exact ih (step g s c).store (step_state_declared g states s c current closed)

end Merv.Workflow
