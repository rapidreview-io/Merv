import Lean
import BackendEvents
open Lean
namespace Merv.BackendEvents

private def ids (s : State) (f : Nat → Bool) : List Nat :=
  (List.range (s.allocated + 1)).filter fun i => i > 0 && f i
private def repeated (s : State) (f : Nat → Nat) : List Nat :=
  (List.range (s.allocated + 1)).flatMap fun i => List.replicate (f i) i
private def view (s : State) : Json := Json.mkObj [
  ("allocated", toJson s.allocated), ("head", toJson s.head),
  ("cursor", toJson s.cursor), ("baseline", toJson s.baseline),
  ("serial", toJson s.serial), ("attempts", toJson s.attempts),
  ("retryAt", toJson s.retryAt), ("clock", toJson s.clock),
  ("active", toJson s.active), ("registered", toJson s.registered),
  ("events", toJson (ids s s.committed)), ("records", toJson (ids s s.records)),
  ("effects", toJson (repeated s s.effects)), ("external", toJson (repeated s s.external))]

private def executeCommand (s : State) (j : Json) : Except String State := do
  let kind ← (← j.getObjVal? "kind").getStr?
  match kind with
  | "publish" =>
    let wanted ← fromJson? (← j.getObjVal? "wanted")
    let abort : Bool := (j.getObjValAs? Bool "abort").toOption.getD false
    let staged := step s (.beginPublish wanted)
    return step staged (if abort then .abort staged.serial else .commit staged.serial)
  | "drain" =>
    let fail : Bool := (j.getObjValAs? Bool "fail").toOption.getD false
    return pump s fail (s.head - s.cursor + 1)
  | "beginPublish" => return step s (.beginPublish (← fromJson? (← j.getObjVal? "wanted")))
  | "beginDelivery" => return step s .beginDelivery
  | "commit" => return step s (.commit (← fromJson? (← j.getObjVal? "ticket")))
  | "abort" => return step s (.abort (← fromJson? (← j.getObjVal? "ticket")))
  | "failure" => return step s (.failure (← fromJson? (← j.getObjVal? "observed")))
  | "subscribe" => return step s (.subscribe (← fromJson? (← j.getObjVal? "fromNow")))
  | "detach" => return step s .detach
  | "crash" => return step s .crash
  | "tick" => return step s (.tick (← fromJson? (← j.getObjVal? "elapsed")))
  | "notification" => return s
  | other => throw s!"Unknown events command: {other}"

private def execute (input : String) : Except String Json := do
  let doc ← Json.parse input
  let mut s : State := {}
  let mut observations := #[]
  for j in ← (← doc.getObjVal? "commands").getArr? do
    s ← executeCommand s j
    observations := observations.push (view s)
  return Json.mkObj [("observations", Json.arr observations)]

def oracleMain : IO UInt32 := do
  match execute (← (← IO.getStdin).readToEnd) with
  | .ok output => IO.println output.compress; return 0
  | .error error => IO.eprintln error; return 1
end Merv.BackendEvents

def main : IO UInt32 := Merv.BackendEvents.oracleMain
