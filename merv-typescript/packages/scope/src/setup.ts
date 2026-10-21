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
Connect/sign in from the plugin's connection UI. Complete the browser authorization.
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

## Browser sign-in and project selection
The browser opens Merv's existing account sign-in. Sign in or sign up there. New users must
create a project or accept an invitation in the website before authorizing. No Git repository
is required. Select the intended project. Check the client name and callback destination on
the consent page, then authorize. The client saves credentials and refreshes them itself.
Authorization allows your current roles in your projects, never additional permissions.

## Verify and use
Call project.list (or project.read with action list), choose the intended project, and pass
its projectId to project.read brief and workflow.read status. Ask which project only when
ambiguous. On an authorized test project, make a small reversible task or document edit,
read it back and undo it. Do not start experiments or machines as a connection test.
Open a fresh chat and say “use Merv”; the saved plugin and connection should work. An expired
or revoked grant may require the client's sign-in action again, never reinstallation or
pasting credentials. Revoke OAuth connections in Merv Settings → Keys (label “OAuth: …”).

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
codex plugin add ${name}@${name}</pre><p>If your version has no plugin install command, install Merv from the added marketplace in desktop Plugins. Use the plugin's Connect action to sign in.</p>
<h3>Claude Code</h3><pre>claude plugin marketplace add MARKETPLACE
claude plugin install ${name}@${name} --scope user</pre><p>Open <code>/mcp</code>, select Merv and authenticate. Reload plugins or restart only if your client requires it.</p>
<h2>3. Sign in and select a project</h2><p>Complete Merv's browser sign-in. A new account must create a project or accept an invitation on the website before authorizing the connection. Review the client and callback address, select your project, and authorize. Your agent keeps your current permissions.</p>
<h2>4. Start a fresh chat</h2><p>Say “use Merv” and ask for your project's status. Your client saves the connection and refreshes credentials. You never need to paste a token into chat.</p><p>To disconnect, revoke the connection in Merv Settings → Keys under its “OAuth:” label. Reconnect through your client's sign-in action when authorization expires.</p>
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
