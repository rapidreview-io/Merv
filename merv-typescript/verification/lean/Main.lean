import Lean
import Workflow

open Lean
open Merv.Workflow

private def field (j : Json) (name : String) : Except String Json :=
  j.getObjVal? name

private def stringField (j : Json) (name : String) : Except String String := do
  (← field j name).getStr?

private def natField (j : Json) (name : String) : Except String Nat := do
  (← field j name).getNat?

private def arrayField (j : Json) (name : String) : Except String (Array Json) := do
  (← field j name).getArr?

private def parseEdge (j : Json) : Except String Edge := do
  return { fromState := ← stringField j "from"
           action := ← stringField j "action"
           toState := ← stringField j "to" }

private def parseGraph (j : Json) : Except String Graph := do
  let initial ← stringField j "initial"
  let terminal ← (← arrayField j "terminal").toList.mapM Json.getStr?
  let edges ← (← arrayField j "edges").toList.mapM parseEdge
  return { initial, terminal, edges }

private def parseCommand (j : Json) : Except String Merv.Workflow.Command := do
  let guard ← match j.getObjVal? "guard" with
    | .ok value => value.getBool?
    | .error _ => .ok true
  return { requestId := ← stringField j "requestId"
           fingerprint := ← stringField j "fingerprint"
           expectedRevision := ← natField j "expectedRevision"
           action := ← stringField j "action"
           guard }

private def parseReceipt (j : Json) : Except String Receipt := do
  let response ← field j "response"
  return { requestId := ← stringField j "requestId"
           fingerprint := ← stringField j "fingerprint"
           response := { state := ← stringField response "state"
                         revision := ← natField response "revision" } }

private def observation (result : Result) : Json := Id.run do
  let (kind, response) := match result.outcome with
    | .committed snap => ("committed", snap)
    | .replayed snap => ("replayed", snap)
    | .revisionConflict => ("revision_conflict", result.store.current)
    | .requestConflict => ("request_conflict", result.store.current)
    | .invalidTransition => ("invalid_transition", result.store.current)
    | .guardRejected => ("guard_rejected", result.store.current)
  return Json.mkObj [
    ("kind", toJson kind),
    ("state", toJson response.state),
    ("revision", toJson response.revision),
    ("currentState", toJson result.store.current.state),
    ("currentRevision", toJson result.store.current.revision),
    ("receiptCount", toJson result.store.receipts.length),
    ("historyLength", toJson result.store.historyLength)]

private def runCommands (g : Graph) (receipts : List Receipt)
    (commands : List Merv.Workflow.Command) : Array Json := Id.run do
  let mut store := { initialStore g with receipts }
  let mut output := #[]
  for command in commands do
    let result := step g store command
    store := result.store
    output := output.push (observation result)
  return output

private def execute (input : String) : Except String Json := do
  let document ← Json.parse input
  let graph ← parseGraph (← field document "graph")
  let receipts ← match document.getObjVal? "initialReceipts" with
    | .ok value => (← value.getArr?).toList.mapM parseReceipt
    | .error _ => pure []
  let commands ← (← arrayField document "commands").toList.mapM parseCommand
  return Json.mkObj [("observations", Json.arr (runCommands graph receipts commands))]

def main : IO UInt32 := do
  let input ← (← IO.getStdin).readToEnd
  match execute input with
  | .ok output =>
      IO.println output.compress
      return 0
  | .error message =>
      IO.eprintln s!"workflow_model: {message}"
      return 1
