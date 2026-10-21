/** Native Codex app-server OAuth for an installed bundled server, never a direct registration. */
import { spawn } from 'node:child_process';
export async function authenticateCodexPlugin(
  env: NodeJS.ProcessEnv,
  cwd: string,
  pluginName: string,
  approve: (authorizationUrl: string) => Promise<void>,
): Promise<{ name: string; pluginId: string }> {
  const child = spawn(process.env.MERV_CODEX_BIN ?? 'codex', ['app-server', '--stdio'], {
    env,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  let next = 0,
    buffer = '';
  let completed: (v: any) => void = () => {};
  const completion = new Promise<any>((resolve) => {
    completed = resolve;
  });
  child.stdout.on('data', (data) => {
    buffer += data.toString();
    for (;;) {
      const i = buffer.indexOf('\n');
      if (i < 0) break;
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const p = pending.get(message.id)!;
        pending.delete(message.id);
        if (message.error) p.reject(new Error(JSON.stringify(message.error)));
        else p.resolve(message.result);
      }
      if (message.method === 'mcpServer/oauthLogin/completed') completed(message.params);
    }
  });
  child.on('error', (error) => {
    for (const p of pending.values()) p.reject(error);
    completed({ success: false, error: error.message });
  });
  child.on('close', () => {
    for (const p of pending.values()) p.reject(new Error('Codex app-server closed'));
    completed({ success: false, error: 'Codex app-server closed' });
  });
  child.stderr.resume();
  const request = (method: string, params: any) =>
    new Promise<any>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  const timeout = setTimeout(() => {
    for (const p of pending.values()) p.reject(new Error('Codex plugin OAuth timed out'));
    completed({ success: false, error: 'Codex plugin OAuth timed out' });
    child.kill();
  }, 60000);
  try {
    await request('initialize', {
      clientInfo: { name: 'merv-plugin-test', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const detail = await request('plugin/read', {
      marketplacePath: cwd + '/plugins/.agents/plugins/marketplace.json',
      pluginName,
    });
    console.log(
      JSON.stringify({
        codexPluginMetadata: {
          servers: detail.plugin.mcpServers,
          installed: detail.plugin.summary.installed,
          enabled: detail.plugin.summary.enabled,
        },
      }),
    );
    const thread = await request('thread/start', {
      cwd,
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });
    const threadId = thread.thread.id;
    const list = await request('mcpServerStatus/list', { threadId });
    const servers = list.data.filter((s: any) => s.pluginId);
    if (servers.length !== 1)
      throw new Error(
        'Expected one bundled MCP server: ' +
          JSON.stringify(
            list.data.map((s: any) => ({
              name: s.name,
              pluginId: s.pluginId,
              authStatus: s.authStatus,
              toolsError: s.toolsError,
            })),
          ),
      );
    const server = servers[0];
    const started = await request('mcpServer/oauth/login', {
      name: server.name,
      threadId,
      clientRegistration: 'dcr',
      scopes: ['merv'],
    });
    await approve(started.authorizationUrl);
    const done = await completion;
    if (!done.success) throw new Error('Bundled login failed: ' + done.error);
    return { name: server.name, pluginId: server.pluginId };
  } finally {
    clearTimeout(timeout);
    child.kill('SIGTERM');
  }
}
