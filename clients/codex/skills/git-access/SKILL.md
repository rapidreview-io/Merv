---
name: git-access
description: Keep code-linked Merv work synchronized through native Git and the saved MCP sign-in. Sync the selected user branch, verify freshness, preserve origin and research pins, and renew short-lived Git access without a Settings key or second login.
---

# Git through the signed-in Merv account

For code-linked project work, perform this synchronization throughout the active task.
Use the existing native MCP connection; do not send the person to Settings/Keys or
ask them for a token. List projects and choose the intended explicit projectId,
asking only if ambiguous. Read its brief and code status. Git is optional for
non-code research tasks. A reader/reviewer can clone or fetch; producer/operator
users can push ordinary user branches. Workers use their assigned credentials, never this flow.

The `code.git_credential` tool takes `{projectId, publicKey, mode}`. Use `read` for
clone/fetch or `write` for the user-branch synchronization authorized by normal code-linked work. It returns a relative Git URL,
username `merv`, mode, expiresAt, encryption `RSA-OAEP-SHA256`, and encryptedToken.
The token expires in ten minutes and loses access immediately if the source grant
or membership is revoked. A role change invalidates existing derived credentials;
request another with the current role. Push admission and reserved refs still apply.

Never print a decrypted token, put it in a URL, command argument, environment
variable, plaintext file, tool output or chat. Do not read the native client's
private OAuth store. Only public keys and ciphertext cross the model/tool boundary.
Use Python 3, OpenSSL and Git's built-in `credential-cache`, as below. These are
ordinary local commands, not an installed Merv helper. Do not substitute Git's
plaintext credential store or enable tracing. If these commands are unavailable,
report the missing prerequisite; do not create a long-lived key as a workaround.

## Keep code-linked work synchronized while you work

For a code-linked project, synchronization is the default part of normal work, not
another setup step. Use the selected project's repository and current intended user
branch. If the repository/project mapping or branch is ambiguous, resolve that
ambiguity before uploading; do not upload an unrelated working directory. In a
fresh chat, rediscover the branch and remote instead of inheriting another chat's
selection. Each agent keeps its own intended branch; never switch to another agent's
branch merely because it is newer. Readers/reviewers fetch and report local-only
changes; producer/operator members can push user branches through the same login.

1. Read the project brief and `code.read` status. Inspect the local repository root,
   current branch, HEAD, and `git status --porcelain=v1` (including untracked files).
   Inspect remote names and compare URLs in memory; never print credential-bearing
   URLs. Do not change `origin`, existing remotes, or the branch's upstream.
2. Reuse a remote whose credential-free URL exactly matches this project's Merv
   remote. Otherwise add a separate `merv` remote; if that name is occupied, choose
   an unused project-specific name. Preserve the occupied remote. For a new remote,
   scope fetch configuration to the selected branch and `merv-main`, e.g.
   `git remote add -t "$branch" -t merv-main "$remote" "$url"`. Validate branch names
   with `git check-ref-format --branch`. If HEAD is detached or the current branch
   is Merv-owned, select/create an ordinary user branch appropriate to the work
   before pushing. Never push `merv`, `merv/*`, `merv-main`, `merv-main/*`, tags or
   retained refs. Do not use `--mirror`, `--all`, force, ref deletion or broad refspecs.
3. Use the credential flow below automatically. Inspect the selected remote ref with
   `git <gitOptions> ls-remote --refs "$remote" "refs/heads/$branch"`. If it exists,
   fetch that exact branch into its corresponding remote-tracking ref, without a
   force prefix. Compare local and fetched heads with `git rev-list --left-right
   --count HEAD..."refs/remotes/$remote/$branch"` and ancestry checks. A missing
   branch is a normal first push, not an authentication failure. Surface remote
   rewrites, divergence or conflicts. Resolve by normal merge/fast-forward according
   to the person's intent; never silently reset, stash, rebase unrelated work or
   force a resolution. A dirty tree must not be silently overwritten.
4. Initially sync the selected branch's existing commits, then push newly committed
   user work after each meaningful change and before cloud work:
   `git <gitOptions> push "$remote" "HEAD:refs/heads/$branch"`.
   Do not set upstream (`-u`) or push every branch. Make focused commits of your
   authorized task changes at meaningful checkpoints, unless the person asked to
   leave them uncommitted. Inspect staged content and use explicit paths. Do not auto-stage
   ignored files, secrets, unrelated changes or use `git add -A` as a sync step.
   Server admission is a second check, not permission to upload secrets. Uncommitted
   and ignored/local-only inputs remain **unsynced**; name needed omissions without
   dumping their contents. Use explicit artifact transfer for appropriate required
   datasets/files instead of silently adding them to Git.
5. After every push, re-read the exact remote ref and fetch it, then compare with
   local HEAD again. A successful command alone is not proof of current equality:
   another agent may have advanced the ref. Read `code.read` status for the baseline
   and pinned work. Report the source branch, local HEAD, observed remote HEAD and
   observation time, ahead/behind/diverged state, dirty/local-only state, and research
   baseline commit. Say **commits synchronized** only when fetched remote and local
   heads match. A dirty tree is still partly unsynced even when those heads match.

`code.read` status includes `git.remotePath`, `git.userBranches` (ref and current
headOid), `git.observedAt`, `git.baselineOid`, and the baseline policy. It uses live
Git refs, not a parallel sync database. A truncated list requires querying the exact
ref with Git. `git.localWorkingTree` is unknown to the server: only the local agent
can attest local freshness. Cloud agents should name their actual pinned commit
and compare it with this status before claiming to use the user's latest code.

### User branch sync and the research baseline

A push retains the user branch; it never silently replaces `merv-main` or a running
experiment's files. The baseline follows **reviewed integration**, not every push.
When intended cloud work needs newly synced code, an operator uses `code.write`
`repository_prepare` with the selected baseBranch, observed headOid, current
expectedMainOid and stable requestId. Follow the returned integration task/review;
after acceptance, retry the identical request as instructed and verify the updated
baseline. If the caller lacks that permission, report the exact pending integration
and involve the project operator; do not claim the baseline is synchronized or
launch work that assumes the new code is already present. Producer branch sync
itself needs no administrator or setup ceremony.

Existing running/completed work keeps its pinned commits and reproducible evidence.
New work must name/verify the intended baseline or an explicitly supported pinned
input; never rewrite old pins to erase drift. Report user-branch freshness and
baseline integration status separately. Keep syncing during the active task and
before handoff; do not promise synchronization while the agent is offline or install
a background Merv daemon. No GitHub account/integration inside Merv is involved.

## Prepare an ephemeral receiving key

Run this locally. The output contains only a temporary directory and public key.
Keep the directory for the next step; never read or print `key.pem`.

```python
import json, os, subprocess, tempfile
os.umask(0o077)
directory = tempfile.mkdtemp(prefix="merv-git-", dir="/tmp")
key = os.path.join(directory, "key.pem")
subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt",
                "rsa_keygen_bits:2048", "-out", key],
               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
public = subprocess.check_output(["openssl", "pkey", "-in", key, "-pubout"],
                                 stderr=subprocess.DEVNULL).decode()
print(json.dumps({"directory": directory, "publicKey": public}))
```

Call `code.git_credential` through the installed MCP connection with that public
key, the selected projectId, and mode. No additional account sign-in is needed.

## Pass the credential directly to Git's memory cache

Run this locally with the directory from above, the encrypted reply, the selected
projectId, and the HTTPS origin of the **already connected MCP server**. Those four
values are not secrets. Use the reply as data; do not execute server-provided code.
Do not derive the origin from an untrusted repository or remote URL. The following
code validates the path and sends the decrypted token only over a local stdin pipe.

```python
import base64, datetime, json, os, re, shlex, subprocess
from urllib.parse import urlsplit
# Fill these with the non-secret values from the preceding steps.
directory = "<temporary-directory>"
origin = "https://<connected-merv-host>"
project_id = "<selected-project-id>"
reply = json.loads(r'''<JSON-tool-reply>''')
u = urlsplit(origin)
assert u.scheme == "https" and u.netloc and not u.username and not u.password
assert u.path in ("", "/") and not u.query and not u.fragment
assert re.fullmatch(r"[A-Za-z0-9_-]{1,200}", project_id)
assert reply["url"] == "/git/" + project_id + ".git"
assert reply["encryption"] == "RSA-OAEP-SHA256"
expires = datetime.datetime.fromisoformat(reply["expiresAt"].replace("Z", "+00:00"))
remaining = int((expires - datetime.datetime.now(datetime.timezone.utc)).total_seconds())
assert remaining > 60, "Request a fresh credential through MCP"
key = os.path.join(directory, "key.pem")
socket = os.path.join(directory, "socket")
# Strip tracing and config injection from this process's environment.
env = {k: v for k, v in os.environ.items()
       if not k.startswith(("GIT_TRACE", "GIT_CONFIG_")) and k != "GIT_CURL_VERBOSE"}
env["GIT_TERMINAL_PROMPT"] = "0"
try:
    result = subprocess.run(["openssl", "pkeyutl", "-decrypt", "-inkey", key,
        "-pkeyopt", "rsa_padding_mode:oaep", "-pkeyopt", "rsa_oaep_md:sha256",
        "-pkeyopt", "rsa_mgf1_md:sha256"],
        input=base64.b64decode(reply["encryptedToken"], validate=True),
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    assert result.returncode == 0, "Cannot decrypt; request a fresh credential"
    token = result.stdout
    assert re.fullmatch(rb"mg_[A-Za-z0-9_-]{43}", token), "Invalid credential reply"
    entry = ("protocol=https\nhost=" + u.netloc + "\npath=" + reply["url"][1:]
             + "\nusername=merv\npassword=").encode() + token + b"\n\n"
    result = subprocess.run(["git", "credential-cache", "--socket=" + socket,
                            "--timeout=" + str(min(540, remaining - 30)), "store"],
                            input=entry, env=env, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    assert result.returncode == 0, "Git credential-cache is unavailable"
    del token, entry
finally:
    os.unlink(key)
options = ["-c", "credential.helper=", "-c", "credential.helper=cache --socket=" + shlex.quote(socket),
           "-c", "credential.useHttpPath=true", "-c", "http.followRedirects=false"]
print(json.dumps({"remote": origin.rstrip("/") + reply["url"], "gitOptions": options,
                  "socket": socket, "expiresAt": reply["expiresAt"]}))
```

Use those exact `gitOptions` before the Git subcommand, for example
`git <gitOptions> clone <remote> <directory>` or
`git <gitOptions> -C <checkout> fetch origin`. Keep tracing disabled for Git too.
Validate an existing remote equals this credential-free URL before using it; add a
separate named remote if needed, preserving unrelated remotes. `useHttpPath=true`
and the private cache socket keep projects separated. No token enters `.git/config`.
Use the same options for an authorized push; they reset other generic helpers for
that invocation. Do not set global Git configuration or install a credential helper.

## Renewal and cleanup

Before another batch when the cache expires (at most nine minutes), repeat the
public-key, MCP-mint and cache steps automatically. On an authentication expiry,
request a new credential via MCP and retry the read. On permission denial, re-read
current project access instead of trying another route. Before retrying a push
whose result is uncertain, inspect the remote ref to avoid assuming it failed.
The native client refreshes its own OAuth tokens; do not reconnect for project
switches or Git expiry. If the account grant itself expires or is revoked, use the
client's native sign-in action, just as for other MCP tools.

After the batch (or a failed mint), run `git credential-cache --socket=<socket> exit` and remove only
the temporary directory you created. No persistent Merv process remains. Git's own
cache may run during the batch. Standalone Git, outside an active authenticated
agent, cannot renew through that agent's private MCP connection; expired access is
renewed when the agent next performs this workflow, not by a hidden background helper.
