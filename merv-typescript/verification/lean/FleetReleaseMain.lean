import Lean
import FleetRelease

open Lean Merv.FleetRelease

private def nat (j : Json) (key : String) : Except String Nat := do
  (← j.getObjVal? key).getNat?

private def natDefault (j : Json) (key : String) (fallback : Nat) : Except String Nat :=
  match j.getObjVal? key with
  | .error _ => pure fallback
  | .ok value => value.getNat?

private def parse (j : Json) : Except String Merv.FleetRelease.Command := do
  match ← (← j.getObjVal? "kind").getStr? with
  | "queueCreate" =>
      return .queueCreate (← nat j "key") (← nat j "profile")
        (← (← j.getObjVal? "connected").getBool?)
  | "sendCreate" => return .sendCreate
  | "createEffect" => return .createEffect
  | "refuseEffect" => return .refuseEffect
  | "receiveHandle" => return .receiveHandle
  | "receiveRefusal" => return .receiveRefusal
  | "lostReply" => return .lostReply
  | "cancel" => return .cancel
  | "queueStop" => return .queueStop
  | "stopEffect" => return .stopEffect
  | "queueRenew" => return .queueRenew
  | "renewEffect" => return .renewEffect
  | "providerTerminal" => return .providerTerminal
  | "observeTerminal" => return .observeTerminal
  | "release" => return .release
  | "clock" => return .clock (← nat j "now")
  | "observeExpiry" => return .observeExpiry (← nat j "expires")
  | "restart" => return .restart (← nat j "replacementProfile") (← nat j "replacementLease")
  | _ => throw "unknown command"

private def observation (s : State) : Json := Json.mkObj [
  ("key", toJson s.key), ("profile", toJson s.profile),
  ("originalLease", toJson s.originalLease), ("held", toJson s.held),
  ("released", toJson (!s.held)), ("cancelled", toJson s.cancelled),
  ("attempts", toJson s.attempts), ("queued", toJson s.queued),
  ("inFlight", toJson s.inFlight), ("created", toJson s.created),
  ("refused", toJson s.refused),
  ("provider", toJson (match s.provider with
    | .absent => "absent" | .live => "live" | .stopped => "stopped")),
  ("knownHandle", toJson s.knownHandle), ("terminalSeen", toJson s.terminalSeen),
  ("noEffectSeen", toJson s.noEffectSeen), ("pendingStops", toJson s.pendingStops),
  ("pendingRenews", toJson s.pendingRenews), ("now", toJson s.now),
  ("observedExpiry", toJson s.observedExpiry), ("providerExpiry", toJson s.providerExpiry)]

/-- `oldTimeout: true` is only the executable negative control, never the default rule. -/
private def execute (input : String) : Except String Json := do
  let j ← Json.parse input
  let key ← natDefault j "key" 1
  let profile ← natDefault j "profile" 1
  let originalLease ← natDefault j "originalLease" 3600000
  let old ← match j.getObjVal? "oldTimeout" with
    | .error _ => pure false
    | .ok value => value.getBool?
  let cs ← (← (← j.getObjVal? "commands").getArr?).toList.mapM parse
  let mut s : State := { key, profile, originalLease }
  let mut observations : Array Json := #[]
  for c in cs do
    s := if old then oldStep s c else step s c
    observations := observations.push (observation s)
  return Json.mkObj [("observations", Json.arr observations)]

def main : IO UInt32 := do
  match execute (← (← IO.getStdin).readToEnd) with
  | .ok result => IO.println result.compress; return 0
  | .error err => IO.eprintln s!"fleet_release_model: {err}"; return 1
