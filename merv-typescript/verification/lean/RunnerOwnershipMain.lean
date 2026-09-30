import Lean
import RunnerOwnership
open Lean Merv.RunnerOwnership

private def nat (j : Json) (n : String) : Except String Nat := do
  (← j.getObjVal? n).getNat?
private def flag (j : Json) (n : String) : Except String Bool := do
  (← j.getObjVal? n).getBool?
private def parse (j : Json) : Except String Merv.RunnerOwnership.Command := do
  match ← (← j.getObjVal? "kind").getStr? with
  | "claim" => return .claim (← nat j "actor")
  | "cancel" => return .cancel
  | "launch" => return .launch (← nat j "actor") (← nat j "key")
  | "groupStart" => return .groupStart
  | "running" => return .running
  | "shutdown" => return .shutdown ((j.getObjVal? "natural" >>= Json.getBool?).toOption.getD false)
  | "kill" => return .kill (← flag j "evidence")
  | "exit" => return .exit (← flag j "evidence")
  | "lost" => return .lost (← flag j "boot") (← flag j "aged")
  | "inspect" => return .inspect
  | "guardianCrash" => return .guardianCrash
  | k => throw s!"unknown Runner command {k}"
private def phase : Phase → String
  | .reserved => "reserved" | .starting => "starting" | .running => "running"
  | .stopping => "stopping" | .exited => "exited" | .stopped => "stopped"
  | .uncertain => "uncertain"
private def observe (s : State) (reply : Json) : Json := Json.mkObj [
  ("reply", reply), ("phase", toJson (phase s.row.phase)), ("pinned", toJson s.row.pinned),
  ("claims", toJson s.claims), ("ownerSpawns", toJson s.ownerSpawns),
  ("workerStarts", toJson s.workerStarts)]
private def execute (input : String) : Except String Json := do
  let doc ← Json.parse input
  let commands ← (← doc.getObjVal? "commands").getArr?
  let mut s : State := {}
  let mut observations := #[]
  for c in commands do
    let command ← parse c
    let reply := match command with
      | .launch g key => toJson (launchReply s g key)
      | _ => Json.null
    s := step s command
    observations := observations.push (observe s reply)
  return Json.mkObj [("observations", Json.arr observations)]
def main : IO UInt32 := do
  match execute (← (← IO.getStdin).readToEnd) with
  | .ok j => IO.println j.compress; return 0
  | .error e => IO.eprintln e; return 1
