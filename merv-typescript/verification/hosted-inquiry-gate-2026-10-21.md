# Hosted inquiry gate diagnosis — 21 October 2026

Based on `d6ade02609d86f1d3ec63f233b1b4b3ad517039d`, in the isolated
`standard-git-remote/Merv` worktree. Runner fix: `d6c9677e3`; disposable AppArmor
lifecycle: `28f99a280`; pinned seccomp exception: `1a43b768f`.

All four unchanged Linux gates pass through the final release-runner path with the
failed image and only the rebuilt runner bundle overlaid for the workflow gate.
The five actual JSON reports (Pi reports both fresh and prestarted modes) are in
[hosted-inquiry-gates-2026-10-21.jsonl](hosted-inquiry-gates-2026-10-21.jsonl).
This is diagnostic evidence, not a rebuilt release-image or Cloudflare acceptance.

## Exact failing artifact

- Prepare run: `20261021T125719Z-d6ade026`.
- Hosted image: `sha256:64e5d9ddee160e8b35aee8a2287af4b676191419d9b24e28e46da1a5d5f211e3`.
- Merv source: `d6ade02609d86f1d3ec63f233b1b4b3ad517039d`.
- Sandboxes source: `718b2f78b5d7758da843460dfae591d859693048`.
- Unmodified `linux-workflow-gate.py` SHA256:
  `ddd1c1be2f92f8821782b48546b161676984e3044c8af9a3758d142e2be92057`.
- Patched supervisor bundle SHA256:
  `f4c7efc1d8c0667dc19ee7c4cccbcf0b0793ff0f416fa86a850d3cc5455f3e99`.

Diagnostic containers used the exact image on ResearchSuite_Control with `--rm`,
`--network none`, synthetic loopback endpoints and credentials, and private read-only
probe/bundle mounts. They did not mount production data, credentials or databases.
Release markers, catalog, pins and production container policies were unchanged.
No Cloudflare resources or model calls were used.

## Independent failures

1. **Inquiry launcher mount setup.** Original Docker flags reproduce inquiry exit 70,
   `assignment launch refused`, and zero inquiry relay calls. `SYS_ADMIN` permits
   `unshare(CLONE_NEWNS)`, but Docker's default AppArmor profile separately denies
   making the mount private (EACCES). With `SYS_ADMIN` and `apparmor=unconfined`, the
   retained inquiry calls the relay once with the original `Reply done.` history.
   Attestation succeeds before the mount attempt, so its receipt alone did not
   establish a successful Codex launch.
2. **Planned shutdown delivery.** With inquiry working, the unchanged eight-second
   stop assertion fails: `prepareShutdown()` sets `stopping`, which prevented
   `deliverOne()` from confirming the transcript it was waiting to drain. The fix
   uses the existing ordinary-stop promise to abort delivery only for ordinary
   stop. With that single rebuilt bundle mounted over the exact image, inquiry and
   the unchanged stop assertion pass. No new lifecycle state was added.
3. **Codex user namespace.** The next unchanged shell assertion fails with
   `bwrap: setting up uid map: Permission denied`. Disabling Docker seccomp as well
   produces the same failure. Kernel logs explicitly record `unconfined` transitioning
   to `unprivileged_userns`, then denial of `setpcap` and `/proc/.../uid_map` access
   for UID12001. Host `kernel.apparmor_restrict_unprivileged_userns=1`;
   `kernel.unprivileged_userns_clone=1`. No host policy was changed during those attempts.
4. **Codex pivot-root syscall.** After the release owner approved a scoped diagnostic,
   a new named, unattached AppArmor profile permitted the user namespace. The unchanged
   workflow then reached `bwrap: pivot_root: Operation not permitted`. Docker's
   [default seccomp policy](https://docs.docker.com/engine/security/seccomp/) denies
   `pivot_root`; this run retained that policy. Kernel logs recorded the profile's
   load and removal without an AppArmor denial during this first named-profile attempt.

   The host reports Docker29.6.0 revision `70eaf5e`. Its exact bundled
   [default policy](https://raw.githubusercontent.com/moby/moby/70eaf5e/vendor/github.com/moby/profiles/seccomp/default.json)
   has SHA256 `536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`,
   default action ERRNO1, and no `pivot_root` rule, including in the SYS_ADMIN block.
   After separate release-owner authorization, the diagnostic preserved that parsed
   policy and appended only `{"names":["pivot_root"],"action":"SCMP_ACT_ALLOW"}`.
   With this exception the unchanged workflow gate passed twice, each with
   `codexSandboxOnHost=true` and `codexSandboxPerLaunch=[true,true,true]`; the review
   gate also passed. The initial diagnostic policy file SHA256 was
   `97b1b40cfc034e2b9e59b69daa92ba3a613f8ebfb5b4537f1800b3e17daeddd0`.

The unchanged read-only review gate passed on the exact image with `SYS_ADMIN`,
`apparmor=unconfined` and default Docker seccomp. The local Docker Desktop attempt
is not supporting evidence: amd64 emulation
fails the supervisor's fixed `/proc/.../cmdline` assertion before inquiry.

## Local checks

- New shutdown regression tests: 2 passed; the planned-delivery test fails on the
  original source and passes with the fix.
- Runner suite: 27 passed, 1 existing macOS/Linux skip, 0 failed. PostgreSQL fixtures
  used a dedicated local cluster on port64306, not a production database.
- Deployment suite: 124 passed, 0 failed. The final targeted host-runner suite passed
  53 tests, including lifecycle ownership/collision checks, cleanup ordering,
  exact policy parity, Docker-version/default-policy/hash refusal, and boundary-lane
  classification for baseline changes.
- Typechecking, supervisor bundle build, targeted formatting and `git diff --check`
  passed. Independent agents reviewed the shutdown fix and the policy diagnosis.

## Scoped AppArmor diagnostic and lifecycle support

The actual host's AppArmor4 parser accepted this syntax with kernel loading and
cache writes disabled:

```text
abi <abi/4.0>,
profile merv-hosted-gate-20261021-inquiry flags=(unconfined) {
  userns,
}
```

There is no executable attachment. After explicit release-owner authorization, the
diagnostic created `merv-hosted-gate-5c3d886399a49ff0`, selected it only on the disposable
synthetic workflow container, and retained default Docker seccomp. The failure above
still executed cleanup: the exact container and newly created profile are absent.
The host audit log records profile load at 13:29:45UTC and removal at 13:30:11UTC.

The automated boundary-gate helper checks that both its random profile name and exact
container name are absent before adding anything. It never replaces a profile; only
workflow and review gates select it. It logs the cleanup identity before loading,
removes its exact container before unloading, and retains the profile if container
removal fails. Worker-lane behavior is unchanged. No global sysctls, existing profiles,
boot policy, production container policy, or gate assertions changed.

Independent lifecycle review caught and resolved a container-name ownership edge;
the collision now refuses without profile load or container removal. Independent
review verified the pinned upstream bytes and that the derived policy adds exactly
one rule. Docker version/Git commit, builtin daemon policy, and baseline SHA are
checked before writing it. A Docker upgrade requires explicit baseline review.

## Final release-path diagnostic

The final `Step.gates()` ran all four gates from private copies of the unchanged
committed scripts against the exact failed image. Its only diagnostic substitution
was a read-only bind mount of the patched supervisor bundle for the workflow gate.
The same new release code generated the AppArmor profile, checked the Docker pin,
derived the seccomp policy, selected both policies, parsed the reports, and cleaned
up. Only workflow received the seccomp exception; review and Pi retained the default.

- `linux-pi-gate.py`: pass, both fresh and prestarted reports.
- `linux-workflow-gate.py`: pass, including retained inquiry, original prompt history,
  eight-second shutdown, native patch containment, private-state cleanup, and actual
  Codex sandbox on all three checked launches.
- `linux-isolation-probe-gate.mjs`: pass.
- `linux-review-gate.py`: pass, including read-only kernel mount and zero capabilities.
- Profile/container `merv-hosted-gate-4e106a63dcb5090d`: both removed; independently
  checked no diagnostic profiles or containers remained after the run.
- Final derived policy SHA256:
  `0b8f83a09982ff45519784d4ec802a5ba0c6a8738f37befa43a8b5a21c85d6b6`.
  This differs from the initial diagnostic file only in JSON whitespace.

Successful repeated diagnostic profile `merv-hosted-gate-15d3eca006dc93f0` was also
removed. Local test PostgreSQL was stopped after confirming no other clients, and
the exported local image was removed. Diagnostic logs were retained before cleanup.

These Docker diagnostics still require rebuilding the committed
candidate and running all release gates against that exact image. Actual Cloudflare
workflow, retained inquiry, protected shell, read-only review, and cleanup evidence
remain release-owner acceptance requirements.
