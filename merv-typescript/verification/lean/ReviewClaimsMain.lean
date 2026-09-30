import Lean
import ReviewClaims

open Lean Merv.ReviewClaims

private def field (j : Json) (name : String) : Except String Json := j.getObjVal? name
private def str (j : Json) (name : String) : Except String String := do
  (← field j name).getStr?
private def nat (j : Json) (name : String) : Except String Nat := do
  (← field j name).getNat?
private def booleanField (j : Json) (name : String) : Except String Bool := do
  (← field j name).getBool?

private def parseCommand (j : Json) : Except String Merv.ReviewClaims.Command := do
  match ← str j "kind" with
  | "start" =>
      return .start (← str j "actor") (← str j "claimId") (← nat j "eventId")
        (← booleanField j "permitted") (← booleanField j "independent") (← booleanField j "live")
  | "submit" =>
      return .submit (← str j "actor") (← str j "claimId") (← str j "verdict")
        (← booleanField j "permitted") (← booleanField j "independent") (← booleanField j "live")
  | "revoke" => return .revoke (← str j "actor") (← nat j "eventId")
  | "release" => return .release (← str j "actor") (← str j "claimId")
  | other => throw s!"unknown command: {other}"

private def statusName : Status → String
  | .requested => "requested"
  | .started => "started"
  | .submitted => "submitted"

private def outcomeName : Outcome → String
  | .claimed => "claimed"
  | .existing => "existing"
  | .submitted => "submitted"
  | .released => "released"
  | .unchanged => "unchanged"
  | .forbidden => "forbidden"
  | .independence => "independence"
  | .unavailable => "unavailable"
  | .closed => "closed"
  | .staleClaim => "stale_claim"

private def observe (r : Result) : Json := Json.mkObj [
  ("outcome", toJson (outcomeName r.outcome)),
  ("status", toJson (statusName r.store.status)),
  ("generation", toJson r.store.generation),
  ("reviewer", toJson r.store.reviewer),
  ("claimId", toJson r.store.claimId),
  ("verdict", toJson r.store.verdict),
  ("pinned", toJson r.store.pinned)]

private def execute (input : String) : Except String Json := do
  let document ← Json.parse input
  let pinned ← str document "pinned"
  let commands ← (← field document "commands").getArr?
  let commands ← commands.toList.mapM parseCommand
  let mut store : Store := { pinned }
  let mut observations : Array Json := #[]
  for command in commands do
    let result := step store command
    observations := observations.push (observe result)
    store := result.store
  return Json.mkObj [("observations", Json.arr observations)]

def main : IO UInt32 := do
  let input ← (← IO.getStdin).readToEnd
  match execute input with
  | .ok output => IO.println output.compress; return 0
  | .error message => IO.eprintln s!"review_claim_model: {message}"; return 1
