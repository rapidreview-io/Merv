import Lean
import FleetLease
open Lean Merv.FleetLease
private def nat (j : Json) (key : String) : Except String Nat := do
  (← j.getObjVal? key).getNat?
private def parse (j : Json) : Except String Merv.FleetLease.Command := do
  match ← (← j.getObjVal? "kind").getStr? with
  | "observe" => return .observe (← nat j "expires")
  | "stop" => return .stop (← nat j "now")
  | "reap" => return .reap (← nat j "now")
  | "terminal" => return .terminal
  | "restart" => return .restart (← nat j "replacementLease")
  | _ => throw "unknown command"
private def execute (input : String) : Except String Json := do
  let j ← Json.parse input
  let original ← match j.getObjVal? "originalLease" with
    | .error _ => pure none
    | .ok .null => pure none
    | .ok value => pure (some (← value.getNat?))
  let cs ← (← (← j.getObjVal? "commands").getArr?).toList.mapM parse
  let mut s : State := { originalLease := original }
  let mut out : Array Json := #[]
  for c in cs do
    s := step s c
    out := out.push (Json.mkObj [("released", toJson s.released), ("releaseBy", toJson s.releaseBy),
      ("observedExpiry", toJson s.observedExpiry), ("originalLease", toJson s.originalLease)])
  return Json.mkObj [("observations", Json.arr out)]
def main : IO UInt32 := do
  match execute (← (← IO.getStdin).readToEnd) with
  | .ok result => IO.println result.compress; return 0
  | .error err => IO.eprintln s!"fleet_lease_model: {err}"; return 1
