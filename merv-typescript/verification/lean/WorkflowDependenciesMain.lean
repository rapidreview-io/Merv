import Lean
import WorkflowDependencies
open Lean Merv.WorkflowDependencies

private def nat (j : Json) (name : String) : Except String Nat := do
  (← j.getObjVal? name).getNat?
private def targets (j : Json) : Except String (List Nat) := do
  (← (← j.getObjVal? "targets").getArr?).toList.mapM Json.getNat?
private def parse (j : Json) : Except String Merv.WorkflowDependencies.Command := do
  match ← (← j.getObjVal? "kind").getStr? with
  | "add" => return .add (← nat j "source") (← targets j)
  | "drop" => return .drop (← nat j "source") (← targets j)
  | "replace" => return .replace (← nat j "source") (← nat j "owner") (← targets j)
  | "finish" => return .finish (← nat j "node")
  | "fail" => return .fail (← nat j "node")
  | "gate" => return .gate (← nat j "node")
  | kind => throw s!"unknown command {kind}"
private def observe (r : Result) : Json := Json.mkObj [
  ("outcome", toJson r.outcome),
  ("edges", toJson (r.store.edges.map fun e => toJson [e.source, e.target, e.owner])),
  ("revisions", toJson ((List.range r.store.nodes).map (revision r.store))),
  ("states", toJson ((List.range r.store.nodes).map fun node =>
    if node ∈ r.store.done then "done" else if node ∈ r.store.failed then "failed" else "working"))]
private def execute (input : String) : Except String Json := do
  let doc ← Json.parse input
  let nodes ← nat doc "nodes"
  if nodes > 5 then throw "executable oracle supports at most five nodes"
  let commands ← (← doc.getObjVal? "commands").getArr?
  let mut s : Store := { nodes }
  let mut observations : Array Json := #[]
  for command in commands do
    let r := step s (← parse command)
    observations := observations.push (observe r)
    s := r.store
  return Json.mkObj [("observations", Json.arr observations)]
def main : IO UInt32 := do
  match execute (← (← IO.getStdin).readToEnd) with
  | .ok output => IO.println output.compress; return 0
  | .error message => IO.eprintln s!"workflow_dependencies_model: {message}"; return 1
