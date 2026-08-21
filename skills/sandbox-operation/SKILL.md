---
name: sandbox-operation
description: >-
  Operate Merv cloud sandboxes safely for expensive, long-running, isolated,
  GPU, or remote experiment work. Use when provisioning or attaching a sandbox,
  running commands over SSH, observing durable merv_run receipts, retaining
  outputs, extending a lease, recovering interrupted execution, or releasing a
  sandbox.
---

# Sandbox Operation

Treat the sandbox as an ephemeral machine that bills while it exists. The Merv
brain owns its lifecycle; you own the SSH key, remote commands, and deliberate
retention of every valuable output.

## Operate the sandbox

1. Confirm that the experiment workflow permits execution. Use a local command
   instead when the work is lightweight and safe.
2. Inspect `sandbox.options` when hardware selection is needed. Choose the
   smallest viable option and pass its provider-shaped values back to
   `sandbox.request`; do not invent a generic machine shape.
3. Generate or select a caller-owned SSH keypair. Send only the public key.
   Never send the private key or embed secrets in commands or retained files.
4. Request once. If the response is `needs_selection`, choose from its options.
   If it is `provisioning`, poll with `sandbox.get` after the advised interval;
   do not issue repeated requests as a polling loop.
5. Once running, construct SSH from the returned host, port, and user with your
   private key. Follow response hints for the remote experiment directory and
   expiry.

Use `sandbox.attach` only to associate an already-running sandbox with another
experiment. Use `additional: true` only when the work genuinely needs another
machine instead of the experiment's existing live sandbox.

## Run and observe

Run commands expected to take more than a few minutes through:

```sh
merv_run <unique-label> -- <command>
```

`merv_run` detaches from SSH, survives disconnects, and records a durable
receipt. Labels are one-shot, so use a new label for every launch.

Immediately call `sandbox.runs` after launch. If registration is still
catching up, retry until the label appears. Observe the receipt rather than
polling terminal text:

- Arm `merv-runs-wait` from the returned `wait_url` when the client supports a
  background watcher. Re-arm it when its hold expires. Platform-specific
  background-process setup belongs in the client documentation.
- Otherwise long-poll `sandbox.runs` within the client's timeout.
- Treat watcher transport failure as unknown observation: read truth once with
  authenticated `sandbox.runs`, then resume observation.
- Read both run `status` and `exit_code`. A terminal watcher response does not
  itself mean the command succeeded.
- Treat `unknown` honestly: the machine died before its receipts were read, so
  retained evidence may establish the result, but absence of evidence requires
  a rerun. `lost` means receipts were read and no completion sentinel existed.

Use `sandbox.terminal` only for concise diagnosis or recovery context, not as a
long-run monitor.

## Keep evidence durable

Write scripts, configs, compact results, reports, and figures under
`$MERV_EXPERIMENT_DIR`. Keep disposable datasets, caches, and bulky
checkpoints under `$RP_DATASET_DIR`.

Before release or expiry:

1. Call `sandbox.pull_outputs` for compact files and run its returned command
   locally with the caller-owned private key.
2. Send heavy files directly to configured durable object storage.
3. Verify the files exist locally before using `artifact.submit`; artifact
   upload cannot read a remote sandbox path.
4. Retain logs needed to explain failures as well as successful results.

Nothing is copied automatically.

## Recover, extend, and release

If infrastructure interrupted execution while the approved design still
stands, record `retry_running` with evidence before replacing the sandbox. Use
a planned retry only when the experimental design itself changes, and keep
rerun outputs distinct.

Call `sandbox.extend` before expiry only when more time is genuinely needed;
extension support and limits are provider-dependent.

Release promptly after retaining the needed evidence. Release is deliberately
two-step:

1. Call `sandbox.release` without confirmation and follow its retention
   checklist. This must not destroy the machine.
2. Only after verifying retention, call it again with
   `confirm_retained: true`.

Release and expiry permanently destroy unretained files.
