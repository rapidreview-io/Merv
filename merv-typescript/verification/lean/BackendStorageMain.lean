import Lean
import BackendStorage
open Lean
namespace Merv.BackendStorage

deriving instance FromJson, ToJson for Caller, Ticket, Content, Artifact

private def nat (j : Json) (key : String) : Except String Nat := j.getObjValAs? Nat key
private def str (j : Json) (key : String) : Except String String := j.getObjValAs? String key
private def bool (j : Json) (key : String) : Except String Bool := j.getObjValAs? Bool key
private def parse (j : Json) : Except String Command := do
  match ← str j "kind" with
  | "grant" =>
    let role ← match ← str j "role" with
      | "producer" => pure ScopeAuthority.Role.producer
      | "reader" => pure ScopeAuthority.Role.reader
      | "operator" => pure ScopeAuthority.Role.operator
      | "reviewer" => pure ScopeAuthority.Role.reviewer
      | role => throw s!"unknown role {role}"
    return .grant (← nat j "actor") (← nat j "project") role
  | "revoke" => return .revoke (← nat j "actor")
  | "advance" => return .advance (← nat j "time")
  | "begin" => return .begin (← nat j "id") (← j.getObjValAs? Caller "caller") (← j.getObjValAs? Ticket "ticket")
  | "put" => return .put (← nat j "project") (← str j "hash") (← j.getObjValAs? Content "content") (← bool j "lost")
  | "start" => return .start (← nat j "op") (← nat j "id") (← j.getObjValAs? Caller "caller")
  | "finish" => return .finish (← nat j "op") (← bool j "outage") (← bool j "lost")
  | "restart" => return .restart
  | kind => throw s!"unknown storage command {kind}"

private def execute (j : Json) : Except String Json := do
  let ids ← j.getObjValAs? (Array Nat) "ids"
  let mut s : Store := {}
  let mut observations := #[]
  for command in ← j.getObjValAs? (Array Json) "commands" do
    let (next, outcome) := step s (← parse command)
    s := next
    let tickets := ids.map fun id => toJson (s.tickets id)
    let attached := ids.map fun id => toJson (s.attached id)
    observations := observations.push (Json.mkObj [
      ("outcome", toJson outcome), ("tickets", toJson tickets),
      ("attached", toJson attached), ("count", toJson (s.next - 1))])
  return Json.mkObj [("observations", toJson observations)]

 def run : IO UInt32 := do
  match Json.parse (← (← IO.getStdin).readToEnd) >>= execute with
  | .ok result => IO.println result.compress; return 0
  | .error e => IO.eprintln s!"backend_storage_model: {e}"; return 1
end Merv.BackendStorage

def main : IO UInt32 := Merv.BackendStorage.run
