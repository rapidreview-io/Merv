import Lean
import Fleet
open Lean Merv.Fleet

private def nat (j : Json) (key : String) : Except String Nat := do
  (← j.getObjVal? key).getNat?
private def str (j : Json) (key : String) : Except String String := do
  (← j.getObjVal? key).getStr?
private def limits (j : Json) : Except String (Nat → Nat) := do
  let fallback ← nat j "project"
  let overrides ← match j.getObjVal? "projectLimits" with
    | .error _ => pure []
    | .ok raw => (← raw.getArr?).toList.mapM fun item => do
      return (← nat item "project", ← nat item "limit")
  return fun project => ((overrides.find? (fun entry => entry.1 == project)).map Prod.snd).getD fallback
private def parseEffect (s : String) : Except String Effect :=
  match s with
  | "create" => .ok .create | "launch" => .ok .launch | "renew" => .ok .renew
  | _ => .error "unknown effect"
private def parse (j : Json) : Except String Merv.Fleet.Command := do
  match ← str j "kind" with
  | "request" => return .request ⟨← nat j "id", ← nat j "project", ← nat j "profile",
      ← nat j "epoch", ← nat j "lease"⟩
  | "reserve" => return .reserve (← nat j "id")
  | "dispatch" => return .dispatch (← nat j "id") (← nat j "ticket") (← parseEffect (← str j "effect"))
  | "reply" =>
    let ticket ← nat j "ticket"
    let reply ← match ← str j "reply" with
      | "ambiguous" => pure Reply.ambiguous
      | "refused" => pure Reply.refused
      | "created" => pure (.created (← nat j "machine") (← nat j "expires"))
      | "launched" => pure (.launched (← nat j "machine") (← nat j "launch") (← nat j "expires"))
      | _ => throw "unknown reply"
    return .reply ticket reply
  | "stop" => return .stop (← nat j "id")
  | "drain" => return .drain (← nat j "id")
  | "running" => return .running (← nat j "id")
  | "terminal" => return .terminal (← nat j "id")
  | "limits" =>
    let g ← nat j "global"
    return .limits g (← limits j)
  | "restart" => return .restart
  | _ => throw "unknown command"

private def observation (s : Store) : Json := Json.mkObj [
  ("held", toJson s.held.length),
  ("rows", toJson (s.rows.reverse.map fun a => Json.mkObj [
    ("id", toJson a.id), ("project", toJson a.project), ("profile", toJson a.profile),
    ("epoch", toJson a.epoch), ("occupied", toJson (held s a.id)),
    ("released", toJson (decide (a.id ∈ s.released))),
    ("intent", toJson (if a.id ∈ s.stopped then "stop" else if a.id ∈ s.drained then "drain" else "run")),
    ("machine", toJson (((receipt s a.id).map (·.machine)).getD 0)),
    ("launch", toJson (((receipt s a.id).map (·.launch)).getD 0)),
    ("admits", toJson (admits s a.id a.epoch a.profile))]))]

private def execute (input : String) : Except String Json := do
  let j ← Json.parse input
  let commands ← (← (← j.getObjVal? "commands").getArr?).toList.mapM parse
  let mut s : Store := { globalLimit := ← nat j "global", projectLimit := ← limits j }
  let mut out : Array Json := #[]
  for c in commands do
    s := step s c
    out := out.push (observation s)
  return Json.mkObj [("observations", Json.arr out)]

def main : IO UInt32 := do
  match execute (← (← IO.getStdin).readToEnd) with
  | .ok result => IO.println result.compress; return 0
  | .error err => IO.eprintln s!"fleet_model: {err}"; return 1
