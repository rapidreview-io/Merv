import Lean
import BackendAuthority

namespace Merv.BackendAuthority.JsonModel
open Lean Merv.BackendAuthority
private def nat (j : Json) (key : String) : Except String Nat := do
  (← j.getObjVal? key).getNat?
private def str (j : Json) (key : String) : Except String String := do
  (← j.getObjVal? key).getStr?
private def flag (j : Json) (key : String) : Except String Bool := do
  (← j.getObjVal? key).getBool?
private def request (j : Json) : Except String Request := do
  let session ← j.getObjVal? "session"
  let selected ← if session == Json.null then pure none else some <$> session.getNat?
  return ⟨← nat j "project", ← nat j "actor", ← nat j "credential", selected⟩
private def role (j : Json) : Except String ScopeAuthority.Role := do
  match ← str j "role" with
  | "producer" => return .producer
  | "reader" => return .reader
  | "reviewer" => return .reviewer
  | "operator" => return .operator
  | _ => throw "invalid role"
private def parse (j : Json) : Except String Command := do
  match ← str j "kind" with
  | "prepare" => return .prepare (← nat j "id") (← request (← j.getObjVal? "request")) 1 1
  | "dispatch" => return .dispatch (← nat j "id") (← request (← j.getObjVal? "request"))
  | "cancel" => return .cancel (← nat j "id")
  | "provider" => return .alter (.provider (← flag j "installed"))
  | "advance" => return .alter (.advance (← nat j "time"))
  | "revokeCredential" => return .alter (.credential 1 (.revoke 1))
  | "revokeExecution" => return .alter (.credential (← nat j "id") (.revoke 2))
  | "revokeActor" => return .alter (.scope (.revokeActor 1))
  | "removeMember" => return .alter (.scope (.remove 1 1))
  | "grantMember" => return .alter (.scope (.grant 1 1 (← role j)))
  | "reloadWorkflow" => return .alter (.session .reload)
  | "unloadWorkflow" => return .alter (.session .unload)
  | "closeSession" => return .alter (.session (.close (← nat j "id") false))
  | "catalog" =>
      let generation ← nat j "generation"
      return .alter (.catalog (if ← flag j "installed" then [⟨generation, 1, 1⟩] else []))
  | "grants" => return .alter (.grants (if ← flag j "installed" then [⟨1, 1, 1, 1⟩] else []))
  | "bindings" =>
      let upstream ← nat j "upstream"
      return .alter (.bindings (if ← flag j "installed" then [⟨1, 1, 1, upstream⟩] else []))
  | other => throw s!"unknown command {other}"
private def execute (raw : String) : Except String Json := do
  let document ← Json.parse raw
  let commands ← (← (← document.getObjVal? "commands").getArr?).toList.mapM parse
  let member := (document.getObjVal? "member" >>= Json.getBool?).toOption.getD false
  let world := if member then { initial with
      scope := { initial.scope with members := [⟨1, 1, 1, .producer⟩], next := 2 }
      links := initial.links.map (fun l => { l with member := some ⟨1, 1, 1, none⟩ }) }
    else initial
  let mut s : Store := { world }
  let mut observations : Array Json := #[]
  for command in commands do
    let result := step s command
    s := result.store
    observations := observations.push (Json.mkObj [
      ("outcome", toJson result.outcome), ("effects", toJson s.effects.length),
      ("upstreams", toJson (s.effects.reverse.map (·.upstream)))])
  return Json.mkObj [("observations", Json.arr observations)]
def run : IO UInt32 := do
  match execute (← (← IO.getStdin).readToEnd) with
  | .ok result => IO.println result.compress; return 0
  | .error error => IO.eprintln s!"backend_authority_model: {error}"; return 1
end Merv.BackendAuthority.JsonModel

def main : IO UInt32 := Merv.BackendAuthority.JsonModel.run
