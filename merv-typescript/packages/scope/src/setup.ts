import { packageArchive, packageFiles, packageName } from './client-package.js';
import type { MountHandler } from '@merv/api/types';
import { escapeHtml } from '@merv/contracts/text';

export function setupGuide(origin: string) {
  const name = packageName(origin);
  const marketplace = name === 'merv' ? 'rapidreview-io/merv-plugins' : 'MARKETPLACE';
  return `# Connect your agent to Merv

Install Merv once in your agent client, sign in in your browser, then use it in fresh chats.
Remote MCP: ${origin}/mcp. No connector, daemon, proxy, repository or API key is needed.
The separate /start/agent.md guide is for public experiment intake, not client setup.

## Before installing
Identify the running client and version; do not install into every client on the machine.
Inspect only MCP server names, transports and URLs, and installed plugin names. Never read,
print or ask for tokens, passwords, email codes, credential files or authentication headers.
If Merv already connects to this origin, reuse it and verify access below.
Do not register both a plugin-bundled server and a standalone server for the same origin.

## Install the Merv plugin
${
  name === 'merv'
    ? `Open your client's Plugins view, add the marketplace reference **rapidreview-io/merv-plugins**
(or https://github.com/rapidreview-io/merv-plugins), then install **Merv** for your user account.
This small public repository contains only plugin metadata, skills and the hosted MCP connection.
It does not install the Merv application, a local server, or the application's source history.
No official-directory listing is required. The terminal equivalents are below.`
    : `This is a separate Merv deployment. Use its origin-specific package, not the production marketplace.
Download ${origin}/connect/bundle.tar.gz and extract it into a persistent user-owned folder,
for example ~/.local/share/${name}/plugins. That folder is MARKETPLACE below (absolute path).
Create the folder first. Standard archive tools can extract it; there is no installer to run.
Agents can instead fetch ${origin}/connect/bundle.json and write its files to that folder.`
}
Preserve unrelated configuration and reuse an existing connection to this origin.

## Codex
Run: codex plugin marketplace add ${marketplace}
On versions offering it, run: codex plugin add ${name}@${name}
Otherwise install Merv from that marketplace in the desktop Plugins directory.
After installing, run: codex mcp login ${name}
This native terminal command authenticates the plugin-bundled server; do not run mcp add.
Open the authorization URL shown by Codex in your browser and complete sign-in and consent.
Keep the command running until Codex confirms login. No desktop app or local auth helper is needed.
This bundled login command was verified with Codex CLI 0.155.0-alpha.2.
The package uses Codex's supported compatibility manifest and remote MCP bundle.
A direct remote connection is also supported: codex mcp add ${name} --url ${origin}/mcp, then codex mcp login ${name}.
Choose that route instead of the bundled connection, not alongside it. Direct registration
alone does not install the plugin skills.

## Claude Code
${name === 'merv' ? 'In Claude Code, open /plugin → Marketplaces → Add and enter rapidreview-io/merv-plugins. Or run in your terminal:' : 'From the extraction directory (MARKETPLACE):'}
claude plugin marketplace add ${marketplace}
claude plugin install ${name}@${name} --scope user
Open /mcp, select the plugin's Merv server and authenticate in the browser.
Use /reload-plugins if your version supports it; restart only if the client asks for it.
For direct MCP without the plugin: claude mcp add --transport http --scope user ${name} ${origin}/mcp
Then authenticate from /mcp. Do not also enable the plugin-bundled server.

## Optional: save tool permissions
Browser sign-in saves identity; tool approval is a separate client setting. To let Merv act
on your behalf across fresh chats without repeated tool prompts, choose a saved permission
scoped to this Merv plugin. Installing the plugin does not change permission policy for you.

Codex: the first write prompt offers Allow, Allow for this session, Always allow, or Cancel.
Always allow persists permission for that particular tool. For all tools from this Merv
server, merge this table into your existing Codex config.toml (normally ~/.codex/config.toml):

[plugins."${name}@${name}".mcp_servers."${name}"]
default_tools_approval_mode = "approve"

Update the existing table if present; do not duplicate it or replace the whole configuration.
Keep unrelated plugin settings and intentional per-tool restrictions. Restart Codex after
editing. This approves this server's tools, including writes, while Merv still enforces your
current account roles. It does not change shell or other servers' permissions.

Claude Code: in /permissions, select Allow → Add a new rule, enter
mcp__plugin_${name}_${name}__*, then save to User settings for use across projects and chats.
This native UI adds the rule to permissions.allow without replacing existing settings.
Choose individual tool rules instead if you want narrower approval. Manual-mode Yes is
one call only; it is not a saved permission. Auto mode may approve harmless calls on its
own, but is not a guarantee that every future write will run without a prompt. Managed
ask/deny rules and existing explicit restrictions can still require approval or block calls.
Never use global permission-bypass flags or an all-servers wildcard to set up Merv.

## Browser sign-in and account authorization
The browser opens Merv's existing account sign-in. Sign in or sign up there. Check the client
name and callback destination, then authorize your account. No project membership, project
selection or Git repository is required. The client saves credentials and refreshes them itself.
Authorization follows your current roles in your projects, including memberships added later;
removed memberships stop granting access. It never adds permissions or creates a project.

## Verify and use
Call project.list (or project.read with action list), choose the intended project, and pass
its projectId to project.read brief and workflow.read status. Ask which project only when
ambiguous, including in a fresh chat. If the list is empty, explain that the account has no
accessible projects yet; the person can create/join one on the website, then list again without
reconnecting. Switching projects only changes the explicit projectId on each call.
On an authorized test project, make a small reversible task or document edit,
read it back and undo it. Do not start experiments or machines as a connection test.
Open a fresh chat and say “use Merv”; the saved plugin and connection should work. An expired
or revoked grant may require the client's sign-in action again, never reinstallation or
pasting credentials. Revoke OAuth connections in Merv Settings → Keys (label “OAuth: …”)
or at ${origin}/ui/account/keys, even with no projects.

## Terminal Git without another sign-in
For code-linked project work, use the bundled git-access skill by default. Direct MCP
clients without loaded skills can fetch ${origin}/connect/bundle.json and read
codex/skills/git-access/SKILL.md (identical for Claude); an already connected client
does not need another installation or sign-in. Preserve origin;
configure a separate Merv remote, sync the selected user branch initially and after meaningful
commits, and verify fetched remote heads before reporting success or starting cloud work.
Report dirty/local-only files and divergence; do not auto-commit unrelated work or push all
branches. Branch sync is separate from reviewed baseline integration; experiments keep pins. Through the saved MCP
connection, code.git_credential accepts an ephemeral RSA public key and explicit projectId,
and returns encrypted ten-minute Git access. Decrypt directly into Git's built-in memory
credential cache; never expose the token in URLs, commands, logs, files or chat. Store,
run the authorized Git batch and verification, then clear the cache in the same live shell
invocation. Native shells may kill caches between exec calls; mint fresh for each later batch. No Settings
key, manual token copy, second browser login, Merv daemon or helper installation is needed.
The agent renews access through MCP before later Git batches. Standalone Git outside an active
agent cannot renew through the native client's private MCP session. Reader roles can fetch;
producer/operator users can push user branches; all existing repository admission checks
and protected refs remain. Sync continues while the agent is active, not while it is offline.

## Migrate an older installation
Back up client configuration privately before changes. Disable/uninstall the old skills-only
or Python Merv plugin first. For a connector registration, remove only the entry whose command
actually invokes merv-connect.mjs for this origin, using the client's MCP remove command in
its original scope. Remove only connector-added approval entries if their provenance is known;
never rewrite or replace whole configuration files. Preserve unrelated servers and policies.
Check user and project scopes for duplicates. If a name belongs to something else, keep it and
use a distinct Merv name. After verifying OAuth, revoke only the old connector's key in Settings
→ Keys, identified by its email-code provenance and machine label. Other Git/CI/API keys remain
valid. Do not delete ~/.merv/connect wholesale: other deployments/clients may still use it.
The old installer and email login endpoints return 410; old issued keys remain valid until
explicitly revoked or expired. Never copy those keys into the plugin.

## Archive fallback and distribution
If repository installation is unavailable, download ${origin}/connect/bundle.tar.gz into a
persistent user-owned directory, add that directory as the marketplace, and install ${name}@${name}.
The archive is tied to the deployed server version; the public marketplace can receive newer
instruction-only updates independently. Do not install both sources as duplicate connections.
Production and staging use distinct plugin names and URLs. A server deployment must enable scope-api.oauth.
`;
}

export function setupRoutes(origin: string): MountHandler {
  return (req, res, r) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.method === 'GET' && r.url.pathname === '/connect/bundle.json')
      return { name: packageName(origin), files: packageFiles(origin) };
    if (req.method === 'GET' && r.url.pathname === '/connect/bundle.tar.gz') {
      res.writeHead(200, {
        'content-type': 'application/gzip',
        'content-disposition': `attachment; filename="${packageName(origin)}-plugins.tar.gz"`,
      });
      res.end(packageArchive(origin));
      return;
    }
    if (req.method === 'GET' && r.url.pathname === '/connect/agent.md') {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      res.end(setupGuide(origin));
      return;
    }
    if (req.method === 'GET' && r.url.pathname === '/connect') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      });
      res.end(connectPage(origin));
      return;
    }
    res.writeHead(410, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'connector_retired',
          message: 'Use the remote MCP plugin with browser sign-in.',
          guide: `${origin}/connect/agent.md`,
        },
      }),
    );
  };
}

/** The first run, as a ladder: install, sign in, ask; one command per client, the client chosen
 *  by a CSS-only switch since the page ships no script. In the app's own tokens, both themes. */
function connectPage(origin: string): string {
  const name = packageName(origin);
  const production = name === 'merv';
  const marketplace = production ? 'rapidreview-io/merv-plugins' : 'MARKETPLACE';
  const code = (text: string) => `<pre>${escapeHtml(text)}</pre>`;
  const install = production
    ? `<p>Add the marketplace, then install the plugin for your account.</p>`
    : `<p>This deployment has its own plugin: <a href="/connect/bundle.tar.gz">download it</a>, extract it to a permanent folder, and use that folder as <code>MARKETPLACE</code>.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect to Merv</title><style>
:root{color-scheme:light;--bg:#f7f8fa;--card:#fff;--soft:#f1f3f6;--text:#111827;--muted:#4b5563;--faint:#666d7b;--line:#e5e7eb;--active:#2563eb;--mono:'SF Mono',ui-monospace,'JetBrains Mono',Menlo,Consolas,monospace}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#111214;--card:#1a1b1e;--soft:#232428;--text:#e5e7eb;--muted:#adadb6;--faint:#8e8e98;--line:#2a2b30;--active:#60a5fa}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(600px,100%);margin:0 auto;padding:clamp(28px,10vh,96px) 16px 64px}
.mark{font:600 15px var(--mono)}h1{margin:4px 0 0;font-size:28px;line-height:1.2;font-weight:600;letter-spacing:-.01em}.lede{margin:6px 0 0;font-size:15px;color:var(--muted)}
.switch{display:inline-flex;gap:2px;margin:28px 0 0;padding:2px;min-width:0;border:1px solid var(--line);border-radius:8px;background:var(--soft)}
.switch label{padding:4px 12px;border-radius:6px;font-size:13px;font-weight:500;color:var(--muted);cursor:pointer}
input[type=radio]{position:absolute;opacity:0;width:0;height:0}
#claude:checked+label,#codex:checked+label{background:var(--card);color:var(--text);box-shadow:0 1px 2px rgba(16,24,40,.08)}
input:focus-visible+label{outline:2px solid var(--active);outline-offset:1px}legend{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.for-claude,.for-codex{display:none}main:has(#claude:checked) .for-claude,main:has(#codex:checked) .for-codex{display:block}
fieldset{border:0}ol{list-style:none;margin:20px 0 0;padding:0;counter-reset:step}
li{position:relative;padding:20px 0 20px 44px;border-top:1px solid var(--line);counter-increment:step}
li::before{content:counter(step);position:absolute;left:0;top:19px;width:26px;height:26px;border:1px solid var(--line);border-radius:50%;background:var(--card);font:600 12px/24px var(--mono);text-align:center;color:var(--muted)}
h2{margin:0;font-size:15px;font-weight:600;line-height:1.35}p{margin:4px 0 0;color:var(--muted)}
pre{margin:10px 0 0;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--soft);font:13px/1.55 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text)}
code{font:.92em var(--mono);overflow-wrap:anywhere}a{color:inherit;text-decoration:underline;text-underline-offset:2px}a:hover{color:var(--active)}
.after{padding-left:44px}.after h2::before{content:'';display:inline-block;width:8px;height:8px;margin:0 8px 1px -22px;border-radius:50%;background:#2f9e44}
.foot{margin:28px 0 0;padding-top:16px;border-top:1px solid var(--line);font-size:12px;color:var(--faint)}.foot a{color:var(--muted)}
@media(max-width:480px){h1{font-size:24px}li,.after{padding-left:38px}li::before{width:24px;height:24px;line-height:22px}}
</style></head><body><main>
<div class="mark">merv</div><h1>Merv, in your agent.</h1><p class="lede">Install the plugin, sign in once, work across your projects.</p>
<fieldset class="switch"><legend>Client</legend><input type="radio" name="client" id="claude" checked><label for="claude">Claude Code</label><input type="radio" name="client" id="codex"><label for="codex">Codex</label></fieldset>
<ol>
<li><h2>Install Merv</h2>${install}<div class="for-claude">${code(`claude plugin marketplace add ${marketplace}\nclaude plugin install ${name}@${name} --scope user`)}</div><div class="for-codex">${code(`codex plugin marketplace add ${marketplace}\ncodex plugin add ${name}@${name}`)}</div>${production ? `<p>Or in your client's Plugins view: Add marketplace → <code>rapidreview-io/merv-plugins</code>, then install Merv. <a href="https://github.com/rapidreview-io/merv-plugins">Plugin repository</a>.</p>` : ''}</li>
<li><h2>Sign in</h2><div class="for-claude">${code(`/mcp`)}<p>Select Merv, choose Authenticate, and approve the connection in your browser.</p></div><div class="for-codex">${code(`codex mcp login ${name}`)}<p>Approve the connection in your browser.</p></div><p>No key to copy: the client keeps the connection. It may ask once for permission to use Merv's tools and local Git.</p></li>
<li><h2>Ask</h2>${code('Use Merv. Show me my projects.')}<p>Switch projects without signing in again. None yet? Create or join one on the website, then ask again. Code work syncs to a separate Merv remote; your own stays as it is.</p></li>
</ol>
<div class="after"><h2>Connected</h2><p>The connection appears under <a href="/ui/account/keys">Account keys</a> as “OAuth: <i>client</i>”, where it can be revoked; it signs in again after 30 days.</p></div>
<p class="foot">Let your agent do it: ask it to read <a href="/connect/agent.md">${escapeHtml(origin)}/connect/agent.md</a>. Already connected elsewhere? That guide covers reuse and migration. <a href="/connect/bundle.tar.gz">Archive fallback</a>.</p>
</main></body></html>`;
}
