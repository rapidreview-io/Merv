import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Caller, WorkspaceTransport } from '@merv/contracts';
import type { Code } from '@merv/code-work/types';

/** Real Git bytes use the same HTTP service as production; only control calls are in process. */
export function gitTransport(current: () => Code, caller: Caller) {
  const server = createServer((req, res) => {
    current()
      .gitRemote.handle(req, res, new URL(req.url!, 'http://127.0.0.1'))
      .catch((error) => {
        if (process.env.MERV_GIT_TEST_DEBUG) console.error(error);
        if (res.headersSent) return res.destroy();
        res.writeHead(error.status ?? 500, { 'content-type': 'text/plain' });
        res.end(`${error.code ?? 'internal_error'}: ${error.message}`);
      });
  });
  const listening = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  const transport: WorkspaceTransport = {
    remoteUrl: (path) => `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
    call: async (route, body) => {
      await listening;
      return current().v2!.call(caller, route, body);
    },
  };
  return {
    transport,
    close: async () => {
      await listening;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
