/**
 * A Merv API with agent sign-in on, at a local origin: Scope with its tools, /account, /projects,
 * /secrets and /connect, a directory stub, and a capture mailer whose codes tests read. Used by
 * the agent sign-in and connector tests and by scripts/connect-e2e.ts.
 */
import { Context } from 'cordis';
import { createService, type DirectoryUser } from '@merv/contracts';
import { ApiServer, ToolRegistry } from '@merv/api';
import { ProjectScope } from '@merv/scope';
import { connectRoutes, scopeRoutes } from '@merv/scope/api';
import { scopeToolsPlugin } from '@merv/scope/tools';
import type { Mail } from '@merv/scope/mail';
import { secretsRoutes } from '@merv/secrets/api';
import type { Secrets } from '@merv/secrets/types';
import { openState } from './state.js';

export const issuer = 'https://identity.example/auth/v1';
export const adaSubject = '11111111-1111-4111-8111-111111111111';

export async function connectServer(
  options: {
    serverName?: string;
    limits?: Record<string, number>;
    /** Replaces the mailer; the default captures every mail. */
    mailer?: (mail: Mail) => Promise<void>;
  } = {},
) {
  const state = await openState();
  let time: number | undefined;
  const clock = () => time ?? Date.now();
  const scope = await createService(new ProjectScope(state, clock));
  const tools = new ToolRegistry(scope, scope.toolPolicy);
  const ctx = new Context();
  ctx.provide('scope', scope);
  ctx.provide('tools', tools);
  await ctx.plugin(scopeToolsPlugin);
  const server = new ApiServer(scope, tools, {});
  const routes = scopeRoutes(scope);
  for (const prefix of ['/account', '/projects'] as const) server.mount(prefix, routes);
  server.mount('/secrets', secretsRoutes({} as Secrets));
  const url = await server.start();

  const person = async (subject: string, email: string, project?: string) => {
    const human = await scope.members.acceptVerifiedIdentity({
      issuer,
      subject,
      expiresAt: new Date(clock() + 3_600_000).toISOString(),
    });
    accounts.set(email.toLowerCase(), subject);
    users.set(subject, { email, anonymous: false, confirmed: true, banned: false, deleted: false });
    const created = project
      ? await scope.members.createProject(human, { name: project, requestId: project })
      : undefined;
    return { human, project: created };
  };
  const accounts = new Map<string, string>();
  const users = new Map<string, DirectoryUser | Error>();
  const mails: Mail[] = [];
  const connect = connectRoutes(scope, {
    clock,
    config: {
      apiKeyEnv: 'UNUSED_IN_TESTS',
      from: 'Merv <login@example.com>',
      publicOrigin: `${url}/`,
      serverName: options.serverName ?? 'merv',
      limits: options.limits ?? {},
    },
    directory: {
      find: async (email) => {
        const subject = accounts.get(email.toLowerCase());
        return subject ? { issuer, subject } : null;
      },
      user: async (subject) => {
        const user = users.get(subject) ?? null;
        if (user instanceof Error) throw user;
        return user;
      },
    },
    mailer: {
      send: async (mail) => {
        if (options.mailer) await options.mailer(mail);
        else mails.push(mail);
      },
    },
  });
  server.mount('/connect', connect.handler, { public: true });
  const ada = await person(adaSubject, 'Ada@Lab.org', 'Grokking');
  /** The code in the newest code email to `to`, once the background delivery has run. */
  const codeFor = async (to: string) => {
    await connect.drain();
    const mail = mails.findLast(
      (sent) => sent.to.toLowerCase() === to.toLowerCase() && sent.subject.includes('sign-in code'),
    );
    return mail && /(\d{4}-\d{4})/.exec(mail.subject)![1]!;
  };
  return {
    url,
    state,
    scope,
    server,
    tools,
    ada,
    person,
    users,
    mails,
    codeFor,
    drain: () => connect.drain(),
    setTime: (value: number | undefined) => {
      time = value;
    },
    async close() {
      await server.stop();
      await connect.drain();
      await ctx.fiber.dispose();
      await tools.close();
      await state.close();
    },
  };
}
