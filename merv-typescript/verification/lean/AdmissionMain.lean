import Lean
import Admission

open Lean
open Merv.Workflow
open Merv.Admission

private def field (j : Json) (name : String) : Except String Json := j.getObjVal? name
private def str (j : Json) (name : String) : Except String String := do
  (← field j name).getStr?
private def nat (j : Json) (name : String) : Except String Nat := do
  (← field j name).getNat?
private def arr (j : Json) (name : String) : Except String (Array Json) := do
  (← field j name).getArr?
private def boolOr (j : Json) (name : String) (fallback : Bool) : Except String Bool :=
  match j.getObjVal? name with
  | .ok value => value.getBool?
  | .error _ => .ok fallback
private def strOr (j : Json) (name : String) (fallback : String) : Except String String :=
  match j.getObjVal? name with
  | .ok value => value.getStr?
  | .error _ => .ok fallback

private def parseEdge (j : Json) : Except String Edge := do
  return { fromState := ← str j "from", action := ← str j "action", toState := ← str j "to" }

private def parseGraph (j : Json) : Except String Graph := do
  return { initial := ← str j "initial"
           terminal := ← (← arr j "terminal").toList.mapM Json.getStr?
           edges := ← (← arr j "edges").toList.mapM parseEdge }

private def parseCommand (j : Json) : Except String Merv.Workflow.Command := do
  return { requestId := ← str j "requestId"
           fingerprint := ← str j "fingerprint"
           expectedRevision := ← nat j "expectedRevision"
           action := ← str j "action"
           guard := true }

private def parseEnvironment (j : Json) : Except String Merv.Admission.Environment := do
  return { handleActiveAtEntry := ← boolOr j "handleActiveAtEntry" true
           mayRead := ← boolOr j "mayRead" true
           ownerMatchesSnapshot := ← boolOr j "ownerMatchesSnapshot" true
           installed := ← boolOr j "installed" true
           handleActiveAtReplay := ← boolOr j "handleActiveAtReplay" true
           postEdgeError := ← strOr j "postEdgeError" ""
           activeBeforeWrite := ← boolOr j "activeBeforeWrite" true
           activeAfterWrite := ← boolOr j "activeAfterWrite" true }

private def parseStep (j : Json) : Except String (Merv.Workflow.Command × Merv.Admission.Environment) := do
  let command ← parseCommand j
  let environment ← parseEnvironment (← field j "environment")
  return (command, environment)

private def observation (result : Merv.Admission.Result) : Json :=
  Json.mkObj [
    ("kind", toJson result.kind),
    ("state", toJson result.response.state),
    ("revision", toJson result.response.revision),
    ("currentState", toJson result.store.current.state),
    ("currentRevision", toJson result.store.current.revision),
    ("historyLength", toJson result.store.historyLength)]

private def runSteps (g : Graph)
    (steps : List (Merv.Workflow.Command × Merv.Admission.Environment)) : Array Json := Id.run do
  let mut store := initialStore g
  let mut output := #[]
  for (command, environment) in steps do
    let result := Merv.Admission.step g store command environment
    store := result.store
    output := output.push (observation result)
  return output

private def execute (input : String) : Except String Json := do
  let document ← Json.parse input
  let graph ← parseGraph (← field document "graph")
  let steps ← (← arr document "steps").toList.mapM parseStep
  return Json.mkObj [("observations", Json.arr (runSteps graph steps))]

def main : IO UInt32 := do
  let input ← (← IO.getStdin).readToEnd
  match execute input with
  | .ok result =>
      IO.println result.compress
      return 0
  | .error message =>
      IO.eprintln s!"workflow_admission_model: {message}"
      return 1
