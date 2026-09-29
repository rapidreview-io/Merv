import Lean

/-
Abstract storage protocol, not a proof of Python, PostgreSQL, Docker or S3.
Keys are scoped to one snapshot. `checked` represents successful real validation.
The implementation must establish these assumptions; integration tests check that boundary.
-/
namespace Merv.Recovery

inductive Part where | database | code
  deriving DecidableEq

structure Manifest where
  databaseHash : Nat
  codeHash : Nat
  databaseEpoch : Nat
  codeEpoch : Nat
  checked : Bool

structure Store where
  payload : Nat → Part → Option Nat
  complete : Nat → Option Manifest

def Verified (s : Store) (id : Nat) (m : Manifest) : Prop :=
  s.payload id .database = some m.databaseHash ∧
  s.payload id .code = some m.codeHash ∧
  m.databaseEpoch = m.codeEpoch ∧ m.checked = true

def Sound (s : Store) : Prop :=
  ∀ id m, s.complete id = some m → Verified s id m

def Selectable (s : Store) (id : Nat) : Prop :=
  ∃ m, s.complete id = some m

def stage (s : Store) (id : Nat) (part : Part) (hash : Nat) : Store :=
  { s with payload := fun i p => if i = id ∧ p = part then some hash else s.payload i p }

def publish (s : Store) (id : Nat) (m : Manifest) : Store :=
  { s with complete := fun i => if i = id then some m else s.complete i }

-- Retention hides the completion marker before removing any payload.
def hide (s : Store) (id : Nat) : Store :=
  { s with complete := fun i => if i = id then none else s.complete i }

def erase (s : Store) (id : Nat) : Store :=
  { payload := fun i p => if i = id then none else s.payload i p
    complete := (hide s id).complete }

theorem incomplete_not_selectable (s : Store) (id : Nat)
    (h : s.complete id = none) : ¬ Selectable s id := by
  simp [Selectable, h]

theorem staging_preserves_soundness (s : Store) (id : Nat) (part : Part) (hash : Nat)
    (hs : Sound s) (unfinished : s.complete id = none) : Sound (stage s id part hash) := by
  intro other m hm
  by_cases same : other = id
  · subst other
    simp [stage, unfinished] at hm
  · have verified := hs other m hm
    simpa [Verified, stage, same] using verified

theorem publish_only_verified (s : Store) (id : Nat) (m : Manifest)
    (hs : Sound s) (hv : Verified s id m) : Sound (publish s id m) := by
  intro other candidate hc
  by_cases same : other = id
  · subst other
    have equality : m = candidate := by simpa [publish] using hc
    simpa [Verified, publish, equality] using hv
  · have previous : s.complete other = some candidate := by simpa [publish, same] using hc
    exact hs other candidate previous

theorem hidden_not_selectable (s : Store) (id : Nat) : ¬ Selectable (hide s id) id := by
  simp [Selectable, hide]

theorem pruning_preserves_soundness (s : Store) (id : Nat)
    (hs : Sound s) : Sound (erase s id) := by
  intro other m hm
  by_cases same : other = id
  · subst other
    simp [erase, hide] at hm
  · have previous : s.complete other = some m := by simpa [erase, hide, same] using hm
    simpa [Verified, erase, same] using hs other m previous

theorem pruning_preserves_retained_snapshot (s : Store) (removed retained : Nat)
    (different : retained ≠ removed) :
    (erase s removed).complete retained = s.complete retained ∧
    (∀ part, (erase s removed).payload retained part = s.payload retained part) := by
  simp [erase, hide, different]

-- Even an interrupted deletion cannot leave the removed point selectable.
theorem deletion_not_selectable (s : Store) (id : Nat) : ¬ Selectable (erase s id) id := by
  simp [Selectable, erase, hide]

-- A failed capture/upload/verification never publishes its staged snapshot.
theorem failed_stage_not_selectable (s : Store) (id : Nat) (part : Part) (hash : Nat)
    (unfinished : s.complete id = none) : ¬ Selectable (stage s id part hash) id := by
  simp [Selectable, stage, unfinished]

theorem selected_snapshot_has_matching_capture (s : Store) (id : Nat) (m : Manifest)
    (hs : Sound s) (selected : s.complete id = some m) :
    m.databaseEpoch = m.codeEpoch ∧ m.checked = true := by
  exact (hs id m selected).2.2

end Merv.Recovery

-- Reject unfinished proofs or custom axioms in every theorem above.
open Lean Elab Command

run_cmd do
  let names := [``Merv.Recovery.incomplete_not_selectable,
    ``Merv.Recovery.staging_preserves_soundness, ``Merv.Recovery.publish_only_verified,
    ``Merv.Recovery.hidden_not_selectable, ``Merv.Recovery.pruning_preserves_soundness,
    ``Merv.Recovery.pruning_preserves_retained_snapshot, ``Merv.Recovery.deletion_not_selectable,
    ``Merv.Recovery.failed_stage_not_selectable, ``Merv.Recovery.selected_snapshot_has_matching_capture]
  for name in names do
    match (← getConstInfo name) with
    | .thmInfo _ => pure ()
    | _ => throwError "Expected a proved theorem: {name}"
  for (name, _) in (← getEnv).constants.toList do
    if `Merv.Recovery |>.isPrefixOf name then
      for axiomName in (← collectAxioms name) do
        unless [``propext, ``Quot.sound, ``Classical.choice].contains axiomName do
          throwError "Disallowed axiom {axiomName} in {name}"
  logInfo m!"Recovery protocol: {names.length} theorems proved; axiom audit passed"
