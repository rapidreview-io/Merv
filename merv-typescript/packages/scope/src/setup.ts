import { packageArchive, packageFiles, packageName } from './client-package.js';
import type { MountHandler } from '@merv/api/types';
import { escapeHtml } from '@merv/contracts/text';
import { handwriting as hw } from './connect-handwriting.js';

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

/** The set-up page is the project's Welcome board: the founder's handwriting (connect-handwriting.ts,
 *  generated from the board) for the title, the labels and the rules, typed text for what a person
 *  copies or follows. No script. */
function connectPage(origin: string): string {
  const name = packageName(origin);
  const production = name === 'merv';
  const marketplace = production ? 'rapidreview-io/merv-plugins' : '<that folder>';
  const code = (text: string) => `<pre>${escapeHtml(text)}</pre>`;
  /** Menu words as quiet chips, what the person types as a mono chip, in order. */
  const path = (steps: (string | ['type', string])[], lead = '') =>
    `<span class="path">${lead ? `<em>${lead}</em><i>›</i>` : ''}${steps
      .map((step) =>
        Array.isArray(step)
          ? `<code>${escapeHtml(step[1])}</code>`
          : `<span>${escapeHtml(step)}</span>`,
      )
      .join('<i>›</i>')}</span>`;
  const archive = production
    ? ''
    : `<p class="note"><a href="/connect/bundle.tar.gz">Download the plugin</a> and extract it to a permanent folder.</p>`;
  const hand = (piece: keyof typeof hw, label: string, cls: string) =>
    `<span class="hand ${cls}" role="img" aria-label="${label}">${hw[piece]}</span>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Welcome to Merv</title><style>
:root{color-scheme:light;--bg:#f7f8fa;--card:#fff;--soft:#f1f3f6;--text:#111827;--ink:#1e1e1e;--muted:#4b5563;--faint:#666d7b;--line:#e5e7eb;--active:#2563eb;--mono:'SF Mono',ui-monospace,'JetBrains Mono',Menlo,Consolas,monospace}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#111214;--card:#1a1b1e;--soft:#232428;--text:#e5e7eb;--ink:#e5e7eb;--muted:#adadb6;--faint:#8e8e98;--line:#2a2b30;--active:#60a5fa}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(760px,100%);margin:0 auto;padding:clamp(28px,8vh,80px) 20px 64px}
.hand{display:block;color:var(--ink)}.hand svg{display:block;height:100%;width:auto;max-width:100%}
.title{height:68px;margin:0 auto 44px;width:fit-content}
.h2{height:48px;margin-bottom:18px}.label{height:38px;padding-top:2px}.rule{height:12px;width:100%;margin:30px 0 26px}.rule svg{width:100%;height:100%}.rule svg{preserveAspectRatio:none}
.row{display:grid;grid-template-columns:120px minmax(0,1fr);gap:8px 16px;align-items:start}.row+.row{margin-top:14px}
.path{display:flex;flex-wrap:wrap;align-items:center;gap:6px 2px;line-height:1.3}.path+.path{margin-top:8px}
.path span,.path code{display:inline-block;padding:4px 10px;border:1px solid var(--line);border-radius:6px;font-size:13px}
.path span{background:var(--card);color:var(--text)}
.path code{background:var(--soft);border-color:var(--active);font:500 13px var(--mono);color:var(--text);overflow-wrap:anywhere}
.path i{padding:0 4px;color:var(--faint);font-style:normal}.path em{font-style:normal;color:var(--muted)}
pre{margin:0;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--soft);font:13px/1.6 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text)}
.ask{display:inline-block;padding:10px 14px;border:1px solid var(--line);border-radius:8px;background:var(--card);font:15px var(--mono)}
.note{margin:10px 0 0;font-size:13px;color:var(--faint)}a{color:inherit}
.look{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border:1px solid var(--line);border-radius:8px;background:var(--card);font-weight:500;text-decoration:none}
.look:hover{border-color:var(--active);color:var(--active)}.look::before{content:'';width:8px;height:8px;border-radius:50%;background:#2f9e44}
.typed{font-size:13px;font-weight:600;color:var(--muted);padding-top:6px}
@media(max-width:560px){.title{height:48px;margin-bottom:32px}.row{grid-template-columns:minmax(0,1fr)}.label{padding-top:0}}
</style></head><body><main>
${hand('title', 'Welcome to Merv', 'title')}
${hand('install', 'Install the plugin', 'h2')}${archive}
<div class="row">${hand('claude', 'Claude', 'label')}<div>${path(['Plugins', 'Add', 'Add marketplace', ['type', marketplace], 'Sync', 'Discover', 'Merv', 'Install'])}${path(['Plugins', 'Merv', 'Authenticate'], 'Sign in')}</div></div>
<div class="row">${hand('codex', 'Codex', 'label')}<div>${path(['Plugins', 'Add marketplace', ['type', marketplace], 'Discover', 'Merv', 'Install'])}${path(['Plugins', 'Merv', 'Connect'], 'Sign in')}</div></div>
<p class="note">Approve the connection in your browser; the client keeps it.</p>
${hand('rule1', '', 'rule')}
${hand('terminal', 'Terminal', 'h2')}
<div class="row"><span class="typed">Claude</span>${code(`claude plugin marketplace add ${marketplace}\nclaude plugin install ${name}@${name} --scope user\n/mcp`)}</div>
<div class="row"><span class="typed">Codex</span>${code(`codex plugin marketplace add ${marketplace}\ncodex plugin add ${name}@${name}\ncodex mcp login ${name}`)}</div>
${hand('rule2', '', 'rule')}
<div class="row">${hand('tryit', 'Try it', 'label')}<div><span class="ask">Use Merv. Show me my projects.</span><p class="note">No project yet? Create or join one, then ask again.</p></div></div>
<div class="row" style="margin-top:36px">${hand('lookatit', 'Look at it', 'label')}<div><a class="look" href="/ui/">${escapeHtml(new URL(origin).host)}</a><p class="note">Your projects, boards and agents, live. The connection is listed under <a href="/ui/account/keys">Account keys</a>; sign in again after 30 days. Or ask your agent to read <a href="/connect/agent.md">/connect/agent.md</a>.</p></div></div>
</main></body></html>`;
}
