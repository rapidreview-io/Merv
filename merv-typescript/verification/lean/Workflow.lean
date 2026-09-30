/-!
An executable abstraction of `WorkflowsService.transitionInternal`.

Each `step` models the workflow instance, receipt, and history projection of
one completed database transaction. A rejected step leaves that projection
unchanged. This does not assert that a caller-supplied outer transaction has
rolled back unrelated writes. Commands are assumed to have passed input
validation and preflight tenancy/owner admission, which TypeScript performs
before receipt lookup. The caller supplies the result of post-edge policy,
context, registration, and compare-and-swap checks as `guard`. The model
assumes a transaction serializes receipt lookup, compare-and-swap, receipt and
history insertion; those database guarantees are outside this Lean proof.

The command fingerprint is an opaque equality token for the canonical payload
computed by TypeScript. The proofs do not establish collision resistance or
correctness of that computation. A graph must be definition-validated before
use; in particular, terminal states have no outgoing edges. The extra terminal
check below makes that invariant explicit in the executable abstraction.
-/

namespace Merv.Workflow

structure Edge where
  fromState : String
  action : String
  toState : String
  deriving Repr, BEq, Inhabited

structure Graph where
  initial : String
  terminal : List String
  edges : List Edge
  deriving Repr, Inhabited

structure Snapshot where
  state : String
  revision : Nat
  deriving Repr, BEq, Inhabited

structure Receipt where
  requestId : String
  fingerprint : String
  response : Snapshot
  deriving Repr, Inhabited

structure Store where
  current : Snapshot
  receipts : List Receipt
  historyLength : Nat
  deriving Repr, Inhabited

structure Command where
  requestId : String
  fingerprint : String
  expectedRevision : Nat
  action : String
  guard : Bool := true
  deriving Repr, Inhabited

inductive Outcome where
  | committed (response : Snapshot)
  | replayed (response : Snapshot)
  | revisionConflict
  | requestConflict
  | invalidTransition
  | guardRejected
  deriving Repr, Inhabited

structure Result where
  store : Store
  outcome : Outcome
  deriving Repr, Inhabited

def initialStore (g : Graph) : Store :=
  -- TypeScript `start` already wrote history revision zero. The start receipt
  -- is omitted: subsequent modeled request IDs are assumed disjoint from it.
  { current := { state := g.initial, revision := 0 }, receipts := [], historyLength := 1 }

def receiptFor (s : Store) (requestId : String) : Option Receipt :=
  s.receipts.find? (fun r => r.requestId == requestId)

def edgeFor (g : Graph) (state action : String) : Option Edge :=
  g.edges.find? (fun e => e.fromState == state && e.action == action)

def reject (s : Store) (reason : Outcome) : Result :=
  { store := s, outcome := reason }

def step (g : Graph) (s : Store) (c : Command) : Result :=
  match receiptFor s c.requestId with
  | some prior =>
      if prior.fingerprint == c.fingerprint then
        { store := s, outcome := .replayed prior.response }
      else reject s .requestConflict
  | none =>
      if s.current.revision != c.expectedRevision then reject s .revisionConflict
      else if g.terminal.contains s.current.state then reject s .invalidTransition
      else
        match edgeFor g s.current.state c.action with
        | none => reject s .invalidTransition
        | some edge =>
            if !c.guard then reject s .guardRejected
            else
              let after : Snapshot :=
                { state := edge.toState, revision := s.current.revision + 1 }
              { store :=
                  { current := after
                    receipts := s.receipts ++
                      [{ requestId := c.requestId, fingerprint := c.fingerprint,
                         response := after }]
                    historyLength := s.historyLength + 1 }
                outcome := .committed after }

-- A fresh command with a stale revision cannot mutate the store.
theorem stale_revision_rejected (g : Graph) (s : Store) (c : Command)
    (fresh : receiptFor s c.requestId = none)
    (stale : (s.current.revision != c.expectedRevision) = true) :
    step g s c = reject s .revisionConflict := by
  simp [step, fresh, stale]

-- Existing receipts take precedence over revision and edge checks.
theorem matching_replay_unchanged (g : Graph) (s : Store) (c : Command)
    (prior : Receipt) (found : receiptFor s c.requestId = some prior)
    (same : (prior.fingerprint == c.fingerprint) = true) :
    step g s c = { store := s, outcome := .replayed prior.response } := by
  simp [step, found, same]

theorem conflicting_replay_unchanged (g : Graph) (s : Store) (c : Command)
    (prior : Receipt) (found : receiptFor s c.requestId = some prior)
    (different : (prior.fingerprint == c.fingerprint) = false) :
    step g s c = reject s .requestConflict := by
  simp [step, found, different]

-- A terminal current state cannot take a new edge. An old receipt may still
-- replay its saved response; in both cases the durable store is unchanged.
theorem terminal_store_unchanged (g : Graph) (s : Store) (c : Command)
    (terminal : (g.terminal.contains s.current.state) = true) :
    (step g s c).store = s := by
  unfold step
  split
  · split <;> rfl
  · split
    · rfl
    · simp [reject]

-- The only way to commit is through an edge selected from the current state
-- and action. A successful command also increments revision and history once.
theorem commit_uses_allowed_edge (g : Graph) (s : Store) (c : Command)
    (after : Snapshot) (committed : (step g s c).outcome = .committed after) :
    ∃ edge, edgeFor g s.current.state c.action = some edge ∧
      after.state = edge.toState ∧
      after.revision = s.current.revision + 1 ∧
      (step g s c).store.historyLength = s.historyLength + 1 := by
  unfold step at committed ⊢
  split at committed
  · split at committed <;> cases committed
  · split at committed
    · cases committed
    · split at committed
      · cases committed
      · split at committed
        · cases committed
        · rename_i edge he
          split at committed
          · cases committed
          · cases committed
            refine ⟨edge, he, rfl, rfl, ?_⟩
            simp_all

-- A replay never inserts a second history entry, even when its saved snapshot
-- has an older revision than the current store.
theorem replay_at_most_once (g : Graph) (s : Store) (c : Command)
    (prior : Receipt) (found : receiptFor s c.requestId = some prior)
    (same : (prior.fingerprint == c.fingerprint) = true) :
    (step g s c).store.historyLength = s.historyLength := by
  rw [matching_replay_unchanged g s c prior found same]

-- The committed receipt is part of the same atomic effect as the state update.
theorem commit_records_receipt (g : Graph) (s : Store) (c : Command)
    (after : Snapshot) (committed : (step g s c).outcome = .committed after) :
    receiptFor (step g s c).store c.requestId =
      some { requestId := c.requestId, fingerprint := c.fingerprint, response := after } := by
  cases hReceipt : receiptFor s c.requestId with
  | some prior =>
      simp [step, hReceipt, reject] at committed
      split at committed <;> cases committed
  | none =>
      by_cases hRev : s.current.revision = c.expectedRevision
      · by_cases hTerminal : s.current.state ∈ g.terminal
        · simp [step, hReceipt, hRev, hTerminal, reject] at committed
        · cases hEdge : edgeFor g s.current.state c.action with
          | none =>
              simp [step, hReceipt, hRev, hTerminal, hEdge, reject] at committed
          | some edge =>
              by_cases hGuard : c.guard = true
              · simp [step, hReceipt, hRev, hTerminal, hEdge, hGuard] at committed
                cases committed
                simp only [step]
                simp [hReceipt, hRev, hTerminal, hEdge, hGuard]
                simp only [receiptFor] at hReceipt
                simp [receiptFor, List.find?_append, hReceipt]
              · simp [step, hReceipt, hRev, hTerminal, hEdge, hGuard, reject] at committed
      · simp [step, hReceipt, hRev, reject] at committed

-- Retrying an identical command immediately after success cannot advance
-- current state, revision, or history a second time.
theorem commit_then_retry_unchanged (g : Graph) (s : Store) (c : Command)
    (after : Snapshot) (committed : (step g s c).outcome = .committed after) :
    (step g (step g s c).store c).store = (step g s c).store := by
  have found := commit_records_receipt g s c after committed
  have same : (c.fingerprint == c.fingerprint) = true := by simp
  have replay := matching_replay_unchanged g (step g s c).store c
    { requestId := c.requestId, fingerprint := c.fingerprint, response := after }
    found same
  rw [replay]

-- Any later command preserves an existing receipt. Thus intervening commands
-- cannot make a request id eligible to commit again.
theorem receipt_preserved (g : Graph) (s : Store) (c : Command)
    (requestId : String) (prior : Receipt)
    (found : receiptFor s requestId = some prior) :
    receiptFor (step g s c).store requestId = some prior := by
  unfold step
  split
  · split <;> simpa [reject] using found
  · split
    · simpa [reject] using found
    · split
      · simpa [reject] using found
      · split
        · simpa [reject] using found
        · split
          · simpa [reject] using found
          · simp only [receiptFor] at found
            simp [receiptFor, List.find?_append, found]

def trace (g : Graph) (s : Store) (commands : List Command) : Store :=
  commands.foldl (fun current command => (step g current command).store) s

theorem trace_preserves_receipt (g : Graph) (s : Store) (commands : List Command)
    (requestId : String) (prior : Receipt)
    (found : receiptFor s requestId = some prior) :
    receiptFor (trace g s commands) requestId = some prior := by
  induction commands generalizing s with
  | nil => simpa [trace] using found
  | cons command rest ih =>
      simp only [trace, List.foldl_cons]
      exact ih (step g s command).store
        (receipt_preserved g s command requestId prior found)

theorem existing_receipt_never_commits (g : Graph) (s : Store) (c : Command)
    (prior : Receipt) (found : receiptFor s c.requestId = some prior) :
    ∀ after, (step g s c).outcome ≠ .committed after := by
  intro after
  unfold step
  simp [found, reject]
  split <;> simp_all

theorem commit_then_interleaved_retry_cannot_commit
    (g : Graph) (s : Store) (c : Command) (after : Snapshot)
    (commands : List Command)
    (committed : (step g s c).outcome = .committed after) :
    ∀ later,
      (step g (trace g (step g s c).store commands) c).outcome ≠ .committed later := by
  have seeded := commit_records_receipt g s c after committed
  have kept := trace_preserves_receipt g (step g s c).store commands
    c.requestId
    { requestId := c.requestId, fingerprint := c.fingerprint, response := after }
    seeded
  exact existing_receipt_never_commits g
    (trace g (step g s c).store commands) c _ kept

end Merv.Workflow
