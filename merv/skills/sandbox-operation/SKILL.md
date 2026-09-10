---
name: sandbox-operation
description: >-
  Operate Merv cloud sandboxes through merv-sandboxes: select hardware, use
  certificate SSH or durable jobs, retain outputs, extend leases, and release
  machines for remote or expensive experiment work.
---

# Sandbox Operation

Merv owns research records and experiment associations. The independent
merv-sandboxes service owns machines, leases, credentials, durable jobs and
physical storage. Ephemeral machines can bill until deletion is confirmed.

## Rent and connect

Confirm that the experiment workflow allows execution. Inspect
`sandbox.options`, choose suitable available hardware, and pass its exact
`provider` and `instance_type` to `sandbox.request`. Supply a caller-owned
OpenSSH public key; keep the private key local. A `needs_selection` response
requires selecting an offer. A `provisioning` response requires polling
`sandbox.get`, not another request.

A running response includes certificate SSH access. Save `ssh.certificate`
beside your private key as `<key>-cert.pub`, pin `ssh.host_public_key` in a
known-hosts file, and connect to `ssh.user@ssh.host` on `ssh.port` using that
key and certificate. Refresh the certificate with `sandbox.get` when it
expires. Never disable host-key checking to make a failed connection work.
The working directory is `/workspace`.

`sandbox.attach` adds a research association to an existing running machine.
Use `additional=true` only when an experiment needs another machine.

## Run and observe

Use `sandbox.run` for durable detached work. Give it a readable name, command,
working directory, timeout and optional output directory. Save its returned
job ID. An idempotency key can safely retry the same submitted job; reuse it
only with identical inputs.

Read `sandbox.job` for state and exit code. Pass the previous `after` cursor
and `wait_seconds` up to 30 to wait for a change. For output, select
`stream=stdout` or `stderr` with an offset and bounded limit; use the returned
extent to detect truncated or expired bytes. `sandbox.runs` lists an
experiment's jobs, including jobs from released machines. Cancellation is
`sandbox.job(cancel=true)`.

Plain SSH commands are not automatically durable jobs. The retired
`merv_run` wrapper is not installed on new machines. To wait for a job, call
`sandbox.runs` with its label and `wait_seconds=30` and call again until the row
is `finished`; 30s is the cap merv-sandboxes honours, so a longer ask would only
promise a hold nobody keeps. The wait spans one turn — a job that finishes after
the turn ends is read back on the next `sandbox.runs` call.
Passive SSH terminal transcripts and utilization samples are unavailable;
use job output and retained results for evidence. Do not infer success from
a connection closing or from a missing receipt.

## Retain and release

Before release or expiry, call `sandbox.pull_outputs` for compact evidence,
substitute the local key/certificate/known-hosts/destination paths, run its
rsync command, and verify the copied files. `artifact.upload` uploads caller
files; it cannot read a sandbox path. Use `storage.submit` for heavy files.
A job output artifact remains in the independent service; preserve its ID and
verify retention before relying on it. Retain useful failure logs too.

Extend a lease with `sandbox.extend` before expiry if the work needs more time;
the service enforces lease and spend limits. If infrastructure interrupted
an approved experiment, record `retry_running` with evidence before rerunning.

Release is two-step: call `sandbox.release`, verify needed outputs are retained,
then repeat with `confirm_retained=true`. A `cleanup_pending` result is a
request for deletion; poll `sandbox.get` until `terminated`. Release and expiry
destroy unretained ephemeral files.
