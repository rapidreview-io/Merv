---
name: git-access
description: Use native terminal Git with Merv after the saved MCP sign-in. Automatically obtain and renew encrypted, short-lived project Git access for clone, fetch or authorized push. No Settings key, token copy-paste, helper installation or second browser login.
---

# Git through the signed-in Merv account

When the person's requested work needs Git, do this yourself as part of that work.
Use the existing native MCP connection; do not send the person to Settings/Keys or
ask them for a token. List projects and choose the intended explicit projectId,
asking only if ambiguous. Read its brief and code status. Git is optional for
ordinary research tasks. A reader/reviewer can clone or fetch; ordinary user pushes
still require project admin. Workers use their assigned credentials, never this flow.

The `code.git_credential` tool takes `{projectId, publicKey, mode}`. Use `read` for
clone/fetch or `write` only for an authorized push. It returns a relative Git URL,
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
