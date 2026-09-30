import Lean
import IdentityCredentials
open Lean Merv.IdentityCredentials

private def nat (j : Json) (key : String) : Except String Nat := do
  (← j.getObjVal? key).getNat?
private def str (j : Json) (key : String) : Except String String := do
  (← j.getObjVal? key).getStr?
private def optionalNat (j : Json) (key : String) : Except String (Option Nat) := do
  let value ← j.getObjVal? key
  if value == Json.null then return none else return some (← value.getNat?)
private def input (j : Json) : Except String Input := do
  return ⟨← nat j "owner", ← nat j "subject", ← nat j "credentialKind",
    ← optionalNat j "expires", ← optionalNat j "deadline"⟩
private def parseOperation (j : Json) (kind : String) : Except String Operation := do
  match kind with
  | "issue" => return .issue (← input j)
  | "adopt" => return .adopt (← input j)
  | "renew" => return .renew (← nat j "owner") (← nat j "expires")
  | "revoke" => return .revoke (← nat j "owner")
  | "authenticate" =>
      let kinds ← (← j.getObjVal? "kinds").getArr?
      return .authenticate (← kinds.toList.mapM Json.getNat?)
  | other => throw s!"unknown command {other}"

private def parse (j : Json) : Except String Merv.IdentityCredentials.Command := do
  match ← str j "kind" with
  | "advance" => return .advance (← nat j "time")
  | "revokeSubject" => return .revokeSubject (← nat j "owner") (← nat j "subject") (← nat j "credentialKind")
  | kind => return .at (← nat j "id") (← parseOperation j kind)

private def rowJson (id : Nat) (r : Row) : Json := Json.mkObj [
  ("id", toJson id), ("owner", toJson r.identity.owner),
  ("subject", toJson r.identity.subject), ("credentialKind", toJson r.identity.kind),
  ("created", toJson r.identity.created), ("expires", toJson r.expires),
  ("deadline", toJson r.identity.deadline), ("revoked", toJson r.revoked)]

private def execute (raw : String) : Except String Json := do
  let document ← Json.parse raw
  let commands ← (← (← document.getObjVal? "commands").getArr?).toList.mapM parse
  let ids := ((commands.filterMap fun c => match c with
    | .at key _ => some key
    | _ => none).mergeSort (· ≤ ·)).eraseDups
  let mut s : Store := {}
  let mut observations : Array Json := #[]
  for c in commands do
    let outcome := match c with
      | .at key op => (evolve s.time (s.rows key) op).outcome
      | _ => "ok"
    s := step s c
    observations := observations.push (Json.mkObj [
      ("outcome", toJson outcome),
      ("rows", toJson (ids.filterMap fun key => (s.rows key).map (rowJson key)))])
  return Json.mkObj [("observations", Json.arr observations)]

def main : IO UInt32 := do
  match execute (← (← IO.getStdin).readToEnd) with
  | .ok result => IO.println result.compress; return 0
  | .error error => IO.eprintln s!"identity_credentials_model: {error}"; return 1
