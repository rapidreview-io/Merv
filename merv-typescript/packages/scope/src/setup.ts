import { packageArchive, packageFiles, packageName } from './client-package.js';
import type { MountHandler } from '@merv/api/types';
import { escapeHtml } from '@merv/contracts/text';

export function setupGuide(origin: string) {
  const name = packageName(origin);
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

## Download the plugin package
Download ${origin}/connect/bundle.tar.gz and extract it into a persistent user-owned folder,
for example ~/.local/share/${name}/plugins. That folder is MARKETPLACE below (absolute path).
Create the folder first. Standard archive tools can extract it; there is no installer to run.
Agents can instead fetch ${origin}/connect/bundle.json and write its files to that folder.
Preserve unrelated configuration; the bundle contains only manifests, metadata and skills.

## Codex
Run: codex plugin marketplace add MARKETPLACE
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
From the extraction directory (MARKETPLACE):
claude plugin marketplace add MARKETPLACE
claude plugin install ${name}@${name} --scope user
Open /mcp, select the plugin's Merv server and authenticate in the browser.
Use /reload-plugins if your version supports it; restart only if the client asks for it.
For direct MCP without the plugin: claude mcp add --transport http --scope user ${name} ${origin}/mcp
Then authenticate from /mcp. Do not also enable the plugin-bundled server.

## Choose persistent tool permission once
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
credential cache; never expose the token in URLs, commands, logs, files or chat. No Settings
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

## Deployment and distribution
The release must publish the clients bundle with its MCP URL set to this origin. Production
and staging need distinct plugin/marketplace names when installed together. This source build
is not automatically a public-directory listing; install from the released bundle until the
publisher has completed directory review. A server deployment must enable scope-api.oauth.
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
      const name = packageName(origin);
      res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect to Merv</title><style>body{max-width:760px;margin:4rem auto;padding:0 1.5rem;font:17px/1.65 system-ui;color:#18212b;background:#faf9f6}h1{font-size:2.6rem;line-height:1.15}h2{margin-top:2.5rem}code{font-size:.9em;overflow-wrap:anywhere}pre{padding:1rem;background:#eeece7;white-space:pre-wrap}a{color:#174e69}li{margin:.6rem 0}</style></head><body>
<h1>Use Merv with your agent</h1><p>Install once, sign in in your browser, then say “use Merv” in a fresh chat. Your agent can work with your projects, experiments, tasks, papers and artifacts. No Git repository is required.</p>
<p><strong>Let your agent set it up:</strong> ask it to read <a href="/connect/agent.md">${escapeHtml(origin)}/connect/agent.md</a>.</p>
<h2>1. Get the plugin</h2><p><a href="/connect/bundle.tar.gz">Download the Merv plugin package</a> and extract it into a permanent folder you own. Use that folder's absolute path as <code>MARKETPLACE</code> below.</p><p>If Merv already connects to this server, reuse that connection. Before replacing an older installation, follow the <a href="/connect/agent.md">migration instructions</a> to preserve unrelated settings.</p>
<h2>2. Install in your client</h2><h3>Codex</h3><pre>codex plugin marketplace add MARKETPLACE
codex plugin add ${name}@${name}
codex mcp login ${name}</pre><p>The login command authenticates the installed plugin's server. Open the URL it displays, complete browser sign-in and consent, and wait for login confirmation. No desktop app is needed. If your version has no plugin install command, use desktop Plugins or the direct-connection alternative in the full guide.</p>
<h3>Claude Code</h3><pre>claude plugin marketplace add MARKETPLACE
claude plugin install ${name}@${name} --scope user</pre><p>Open <code>/mcp</code>, select Merv and authenticate. Reload plugins or restart only if your client requires it.</p>
<h2>3. Sign in and authorize your account</h2><p>Complete Merv's browser sign-in. Review the client and callback address and authorize. No project or repository is required. Your agent follows your current project permissions, including memberships added later. If no projects are accessible yet, create or join one on the website and ask your agent to list again; no reconnect is needed.</p>
<h2>4. Save your tool permission preference</h2><p>Sign-in and tool approval are separate. For Merv to act on your behalf without repeated tool prompts, choose a persistent permission scoped to this plugin. The <a href="/connect/agent.md">full guide</a> shows Codex’s per-tool Always allow and server-specific policy, and Claude Code’s user-level /permissions rule. Existing organization restrictions still apply.</p>
<h2>Git access</h2><p>For code-linked work, your agent keeps the selected user branch synchronized with a separate Merv remote, preserving origin. It verifies commits after pushing and reports uncommitted files or conflicts. The installed plugin obtains and renews short-lived project credentials through the same saved connection. No Settings key or second login is needed. Git access follows your current permissions.</p>
<h2>5. Start a fresh chat</h2><p>Say “use Merv” and ask for your project's status. Your client saves the connection and refreshes credentials. You never need to paste a token into chat.</p><p>To disconnect, revoke the connection in Merv Settings → Keys or <a href="/ui/account/keys">Account keys and connections</a> under its “OAuth:” label, even with no projects. Reconnect through your client's sign-in action when authorization expires.</p>
<p><a href="/connect/agent.md">Full setup, direct-connection alternatives and migration guide</a></p></body></html>`);
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
