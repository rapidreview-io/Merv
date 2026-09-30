import Lean
import SessionOwnership
open Lean Merv.SessionOwnership

private def nat (j : Json) (name : String) : Except String Nat := do
  (← j.getObjVal? name).getNat?
private def str (j : Json) (name : String) : Except String String := do
  (← j.getObjVal? name).getStr?
private def parse (j : Json) : Except String Merv.SessionOwnership.Command := do
  match ← str j "kind" with
  | "offer" => return .offer ⟨← nat j "id", ← nat j "target", ← nat j "revision",
      ← nat j "actor", ← nat j "receipt", ← nat j "expires", ← nat j "hard"⟩
  | "activate" => return .activate (← nat j "id")
  | "close" => return .close (← nat j "id") (← (← j.getObjVal? "expired").getBool?)
  | "release" => return .release (← nat j "id") (← nat j "receipt")
  | "advance" => return .advance (← nat j "time")
  | "move" => return .move (← nat j "target") (← nat j "revision")
  | "reload" => return .reload
  | "unload" => return .unload
  | "prepare" => return .prepare (← nat j "id") (← nat j "session")
  | "run" => return .run (← nat j "id")
  | "cancel" => return .cancel (← nat j "id")
  | "restart" => return .restart
  | kind => throw s!"unknown command {kind}"

private def observe (r : Result) : Json := Json.mkObj [
  ("outcome", toJson r.outcome), ("effects", toJson r.store.effects),
  ("sessions", toJson (r.store.rows.reverse.map fun row => Json.mkObj [
    ("id", toJson row.id),
    ("status", toJson (if row.id ∈ r.store.closed then
      if row.id ∈ r.store.expired then "expired" else "released"
      else if row.id ∈ r.store.active then "active" else "offered")),
    ("released", toJson (decide (row.id ∈ r.store.released)))]))]

private def execute (input : String) : Except String Json := do
  let document ← Json.parse input
  let commands ← (← document.getObjVal? "commands").getArr?
  let mut s : Store := {}
  let mut observations : Array Json := #[]
  for command in commands do
    let r := step s (← parse command)
    observations := observations.push (observe r)
    s := r.store
  return Json.mkObj [("observations", Json.arr observations)]

def main : IO UInt32 := do
  let input ← (← IO.getStdin).readToEnd
  match execute input with
  | .ok output => IO.println output.compress; return 0
  | .error message => IO.eprintln s!"sessions_ownership_model: {message}"; return 1
