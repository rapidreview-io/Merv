import Lean
import ScopeAuthority
open Lean Merv.ScopeAuthority

private def nat (j : Json) (key : String) : Except String Nat := do
  (← j.getObjVal? key).getNat?
private def str (j : Json) (key : String) : Except String String := do
  (← j.getObjVal? key).getStr?
private def boolean (j : Json) (key : String) : Except String Bool := do
  (← j.getObjVal? key).getBool?
private def optionalNat (j : Json) (key : String) : Except String (Option Nat) := do
  let v ← j.getObjVal? key
  if v == Json.null then return none else return some (← v.getNat?)
private def role (j : Json) : Except String Role := do
  match ← str j "role" with
  | "operator" => return .operator
  | "producer" => return .producer
  | "reviewer" => return .reviewer
  | "reader" => return .reader
  | other => throw s!"unknown role {other}"
private def permission (j : Json) : Except String Permission := do
  match ← str j "permission" with
  | "read" => return .read
  | "write" => return .write
  | "review" => return .review
  | "admin" => return .admin
  | other => throw s!"unknown permission {other}"
private def roleName : Role → String
  | .operator => "operator"
  | .producer => "producer"
  | .reviewer => "reviewer"
  | .reader => "reader"

private def execute (raw : String) : Except String Json := do
  let doc ← Json.parse raw
  let commands ← (← doc.getObjVal? "commands").getArr?
  let mut s : Store := {}
  let mut sources : List (Nat × Source) := []
  let mut observations : Array Json := #[]
  for j in commands do
    let mut allowed : Option Bool := none
    match ← str j "kind" with
    | "grant" => s := step s (.grant (← nat j "project") (← nat j "subject") (← role j))
    | "remove" => s := step s (.remove (← nat j "project") (← nat j "subject"))
    | "issueKey" => s := step s (.issueKey ⟨← nat j "id", ← nat j "subject",
        ← nat j "project", ← boolean j "account", ← optionalNat j "expires"⟩)
    | "revokeKey" => s := step s (.revokeKey (← nat j "id"))
    | "issueActor" => s := step s (.issueActor ⟨← nat j "id", ← nat j "project", ← role j⟩)
    | "revokeActor" => s := step s (.revokeActor (← nat j "id"))
    | "advance" => s := step s (.advance (← nat j "time"))
    | "capture" =>
        let project ← nat j "project"
        let subject ← nat j "subject"
        let key ← optionalNat j "key"
        match current s project subject with
        | none => allowed := some false
        | some m =>
            let source : Source := ⟨m.epoch, project, subject, key⟩
            if delegated s source .read then
              sources := (← nat j "id", source) :: sources
              allowed := some true
            else allowed := some false
    | "keyAuthority" => allowed := some (keyAuthority s (← nat j "id")
        (← nat j "project") (← permission j))
    | "actorAuthority" => allowed := some (actorAuthority s (← nat j "id")
        (← nat j "project") (← permission j))
    | kind =>
        let id ← nat j "source"
        let source ← match sources.find? (fun pair => pair.1 == id) with
          | some pair => pure pair.2
          | none => throw s!"unknown source {id}"
        -- A caller-supplied project override tests confused-project requests.
        let selected ← nat j "project"
        let selectedSource := { source with project := selected }
        match kind with
        | "delegated" => allowed := some (delegated s selectedSource (← permission j))
        | "human" => allowed := some (human s selectedSource (← nat j "expires") (← permission j))
        | "worker" =>
            let child ← role j
            allowed := some ((sourceRole s selectedSource).any (fun parent => workerAllowed parent child))
        | "service" => allowed := some (serviceAuthority s source selected
            (← boolean j "reviewService") (← permission j))
        | other => throw s!"unknown command {other}"
    observations := observations.push (Json.mkObj [
      ("allowed", toJson allowed),
      ("members", toJson (s.members.reverse.map fun m => Json.mkObj [
        ("epoch", toJson m.epoch), ("project", toJson m.project),
        ("subject", toJson m.subject), ("role", toJson (roleName m.role)),
        ("active", toJson (decide (m.epoch ∉ s.retired)))]))])
  return Json.mkObj [("observations", Json.arr observations)]

def main : IO UInt32 := do
  match execute (← (← IO.getStdin).readToEnd) with
  | .ok result => IO.println result.compress; return 0
  | .error error => IO.eprintln s!"scope_authority_model: {error}"; return 1
