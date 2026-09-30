import Lean
import BackendRelay
open Lean Merv.BackendRelay

private def number (j : Json) (key : String) : Except String Nat :=
  j.getObjVal? key >>= Json.getNat?

/-- JavaScript's exact integer range is part of the wire representation. Missing,
negative, fractional, string, or overflowing totals are not evidence of zero use. -/
private def usage (j : Json) : Option (Nat × Nat) := do
  let value ← (j.getObjVal? "usage").toOption
  let input ← (number value "input_tokens").toOption
  let output ← (number value "output_tokens").toOption
  if input + output ≤ 9007199254740991 then some (input, output) else none

private def parse (j : Json) : Except String Merv.BackendRelay.Command := do
  match ← (← j.getObjVal? "kind").getStr? with
  | "send" => return .send
  | "terminal" => return .terminal (usage j)
  | "refusedBeforeSend" => return .refusedBeforeSend
  | "upstreamRefused" => return .upstreamRefused
  | "commitCallback" => return .commitCallback
  | "settleRequest" => return .settleRequest (← number j "requestId") (← number j "amount")
  | "forwardUsage" => return .forwardUsage
  | "crash" => return .crash
  | "unknownReply" => return .unknownReply
  | kind => throw s!"Unknown relay command {kind}"

private def observe (s : State) : Json := Json.mkObj [
  ("booked", toJson s.booked), ("callbacks", toJson s.callbacks),
  ("settled", toJson s.settled), ("day", toJson s.day),
  ("commits", toJson s.commits), ("usageForwarded", toJson s.usageForwarded)]

private def execute (raw : String) : Except String Json := do
  let j ← Json.parse raw
  let mut s := initial (← number j "amount") (← number j "day")
    ((number j "requestId").toOption.getD 1)
  let mut observations := #[]
  for command in ← (← j.getObjVal? "commands").getArr? do
    s := step s (← parse command)
    observations := observations.push (observe s)
  return Json.mkObj [("observations", Json.arr observations)]

def main : IO UInt32 := do
  match execute (← (← IO.getStdin).readToEnd) with
  | .ok j => IO.println j.compress; return 0
  | .error e => IO.eprintln e; return 1
