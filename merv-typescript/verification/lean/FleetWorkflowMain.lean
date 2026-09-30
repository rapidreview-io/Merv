import Lean
import FleetWorkflow
open Lean Merv.FleetWorkflow
private def nat (j : Json) (key : String) : Except String Nat := do
  (← j.getObjVal? key).getNat?
private def boolField (j : Json) (key : String) : Except String Bool := do
  (← j.getObjVal? key).getBool?
private def parse (j : Json) : Except String Merv.FleetWorkflow.Command := do
  match ← (← j.getObjVal? "kind").getStr? with
  | "observeIdle" => return .observeIdle
  | "claim" => return .claim (← nat j "epoch")
  | "close" => return .close (← boolField j "capturePending") (← boolField j "acknowledged")
  | "retain" => return .retain
  | "acknowledge" => return .acknowledge
  | "retire" => return .retire
  | "terminal" => return .terminal
  | "time" => return .time (← nat j "now")
  | "restart" => return .restart
  | _ => throw "unknown command"
private def observation (s : State) : Json := Json.mkObj [
  ("stopped", toJson s.stopped), ("released", toJson s.released),
  ("active", toJson (s.session == .active)), ("canRetire", toJson (canRetire s))]
private def execute (input : String) : Except String Json := do
  let j ← Json.parse input
  let cs ← (← (← j.getObjVal? "commands").getArr?).toList.mapM parse
  let mut s : State := {}
  let mut out : Array Json := #[]
  for c in cs do
    s := step s c
    out := out.push (observation s)
  return Json.mkObj [("observations", Json.arr out)]
def main : IO UInt32 := do
  match execute (← (← IO.getStdin).readToEnd) with
  | .ok result => IO.println result.compress; return 0
  | .error err => IO.eprintln s!"fleet_workflow_model: {err}"; return 1
