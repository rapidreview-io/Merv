"""Logs the demo's training runs with the real Trackio client, as training code would.

Usage: python demo_runs.py '<spec JSON>'. TRACKIO_SERVER_URL and TRACKIO_WRITE_TOKEN come from
metrics.write connect, so every write goes through Merv's /trackio proxy and is tagged there.
spec: {"project": str, "runs": [{"name", "config", "curve", "steps", "every", "seed",
"delay", "fast_until", "cost_per_step"}]}. Curves are synthetic but shaped like the real ones: grokking
(train fits early, held-out accuracy jumps late), a smooth fit, and a divergence.
"""
import json
import math
import random
import sys
import time

import trackio


def point(curve, step, steps, rng, at):
    noise = lambda scale: rng.gauss(0, scale)
    if curve == "grok":
        # Train accuracy saturates within a tenth of the run; held-out accuracy jumps near `at`.
        train = 1 - math.exp(-step / (steps * 0.04))
        val = 0.02 + 0.97 / (1 + math.exp(-(step - at) / (steps * 0.03)))
        loss = 4.6 * math.exp(-step / (steps * 0.05)) + 0.02
        return {
            "train/acc": min(1.0, train + noise(0.004)),
            "val/acc": max(0.0, min(1.0, val + noise(0.006))),
            "train/loss": max(0.001, loss * (1 + noise(0.03))),
        }
    if curve == "fit":
        val = 0.55 + 0.33 * (1 - math.exp(-step / (steps * 0.35)))
        return {
            "val/acc": val + noise(0.004),
            "train/loss": 2.3 * math.exp(-step / (steps * 0.3)) + 0.3 + noise(0.01),
        }
    if curve == "diverge":
        # Learns for a while, then the loss blows up and accuracy falls to chance.
        if step < at:
            loss = 2.3 * math.exp(-step / (steps * 0.2)) + 0.4
            val = 0.5 + 0.2 * (1 - math.exp(-step / (steps * 0.2)))
        else:
            loss = 0.6 * math.exp((step - at) / (steps * 0.06))
            val = max(0.1, 0.66 - (step - at) / (steps * 0.25))
        return {"val/acc": val + noise(0.004), "train/loss": min(1e4, loss * (1 + noise(0.02)))}
    raise ValueError(curve)


def main():
    spec = json.loads(sys.argv[1])
    for run in spec["runs"]:
        rng = random.Random(run.get("seed", 0))
        steps, every = run["steps"], run.get("every", 50)
        at = run.get("at", steps * 0.5)
        trackio.init(project=spec["project"], name=run["name"], config=run.get("config", {}))
        cost = 0.0
        for step in range(0, steps + 1, every):
            values = point(run["curve"], step, steps, rng, at)
            cost += run.get("cost_per_step", 0) * every
            if run.get("cost_per_step"):
                values["cost_usd"] = round(cost, 4)
            trackio.log(values, step=step)
            # A run still training: its first part is already logged, the rest arrives slowly.
            if run.get("delay") and step >= run.get("fast_until", 0):
                time.sleep(run["delay"])
        trackio.finish()


if __name__ == "__main__":
    main()
