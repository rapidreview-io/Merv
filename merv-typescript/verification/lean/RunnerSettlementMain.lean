import Lean
import RunnerSettlement
open Lean Merv.RunnerSettlement
private def flag (j : Json) (n : String) (fallback : Bool := true) : Bool :=
  (j.getObjVal? n >>= Json.getBool?).toOption.getD fallback
private def answer (j : Json) (n : String) : Except String Answer := do
  match (j.getObjVal? n >>= Json.getStr?).toOption.getD "complete" with
  | "retry" => return .retry
  | "crash" => return .crash
  | "complete" | "final" => return .complete
  | other => throw s!"unknown answer {other}"
private def parse (j : Json) : Except String Merv.RunnerSettlement.Command := do
  match ← (← j.getObjVal? "kind").getStr? with
  | "poll" => return .poll ⟨← answer j "release", flag j "capture",
      ← answer j "receipt", ← answer j "result", flag j "close"⟩
  | "driver" => return .driver (flag j "present")
  | "terminate" => return .terminate (flag j "evidence")
  | "restart" => return .restart
  | k => throw s!"unknown settlement command {k}"
private def debt (d : Debt) : Json := Json.mkObj [("done", toJson d.done), ("calls", toJson d.calls)]
private def observe (s : State) : Json := Json.mkObj [
  ("terminal", toJson s.terminal), ("driver", toJson s.driver), ("workspace", toJson s.workspace),
  ("release", debt s.release), ("receipt", debt s.receipt), ("result", debt s.result),
  ("captured", toJson s.captured), ("closed", toJson s.closed), ("settled", toJson s.settled),
  ("captures", toJson s.captures), ("closes", toJson s.closes)]
private def execute (input : String) : Except String Json := do
  let doc ← Json.parse input
  let initial := (doc.getObjVal? "initial").toOption.getD Json.null
  let mut s : State := { terminal := flag initial "terminal", driver := flag initial "driver", workspace := flag initial "workspace" }
  let mut observations := #[]
  for c in ← (← doc.getObjVal? "commands").getArr? do
    s := step s (← parse c)
    observations := observations.push (observe s)
  return Json.mkObj [("observations", Json.arr observations)]
def main : IO UInt32 := do
  match execute (← (← IO.getStdin).readToEnd) with
  | .ok j => IO.println j.compress; return 0
  | .error e => IO.eprintln e; return 1
