import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { check } from '@merv/contracts';
import { serveEvents } from '@merv/api/event-stream';
import type { MountHandler } from '@merv/api/types';
import { piLiveView } from '@merv/pi/live';
import type { PiSnapshot } from '@merv/pi/models';
import { customerMessages, type CustomerService } from './service.js';

const route =
  /^\/customer-experiments\/requests\/(ce_[a-f0-9]{32})\/(session|chat)(?:\/(messages|stop|events|voice|warm))?$/;
const messageSchema = z
  .object({
    commandId: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/),
    text: z.string().trim().min(1).max(32000),
  })
  .strict();
const sessionSchema = z.object({ takeOver: z.boolean().optional() }).strict();
/** A request's live chat pages at once: one per tab, never every reader the process keeps. */
const streamsPerRequest = 4;

/**
 * The sponsor's view of the intake conversation, as its customer may see it: the turns' words and
 * where the agent is. Machines, the catalog and its prices, models, tool calls and their results,
 * proposals and the sponsor's ids stay with the sponsor. The shape is Pi's own, so the Pi UI reads
 * it unchanged.
 */
export function customerChat(snapshot: PiSnapshot): PiSnapshot {
  const { conversation, host } = snapshot;
  return {
    stage: snapshot.stage,
    now: snapshot.now,
    available: snapshot.available,
    conversation: {
      id: conversation.id,
      projectId: '',
      userId: '',
      title: conversation.title,
      revision: conversation.revision,
      activeCommandId: conversation.activeCommandId,
      checkpoint: null,
      previousCheckpoint: null,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    },
    commands: snapshot.commands.map((command) => ({
      id: command.id,
      conversationId: command.conversationId,
      epoch: 0,
      runtimeId: '',
      status: command.status,
      messages: customerMessages(command),
      outcomes: [],
      error: command.error,
      createdAt: command.createdAt,
      ...(command.startedAt ? { startedAt: command.startedAt } : {}),
      ...(command.firstTextAt ? { firstTextAt: command.firstTextAt } : {}),
      expiresAt: command.expiresAt,
      completedAt: command.completedAt,
    })),
    host: {
      machine: null,
      preferred: '',
      catalog: [],
      state: host.state,
      idleEndsAt: null,
      idleSeconds: host.idleSeconds,
      moving: null,
      lastMove: null,
    },
    models: [],
    streamId: snapshot.streamId,
    sequence: snapshot.sequence,
    tail: snapshot.tail,
  };
}

/**
 * `/session` and `/chat…` under a request: sign-in binding, and the customer's way into the
 * request's existing Pi intake conversation (PiService as the sponsor, Pi's own event stream).
 * Answers undefined for any other path.
 */
export function chatHttp(service: CustomerService) {
  const open = new Map<object, string>();
  const handle: MountHandler = async (req, res, r) => {
    const [, id, area, action] = route.exec(r.url.pathname)!;
    const method = req.method ?? 'GET';
    if (area === 'session' && !action && method === 'GET')
      return service.access.session(id!, r.bearer());
    if (area === 'session' && !action && method === 'POST')
      return service.access.bind(
        id!,
        r.bearer(),
        req,
        (await r.json(sessionSchema)).takeOver ?? false,
      );
    check(area === 'chat', 'not_found', 'Route not found', 404);
    const { record, identity } = await service.access.requireCustomer(id!, r.bearer(), req);
    // Before service_experiment@3 the customer talks to the intake only through its agent.
    check(identity, 'not_found', 'Route not found', 404);
    if (!action && method === 'GET') {
      const { pi, caller, id: conversation } = await service.intake(record);
      return customerChat(await pi.snapshot(caller, conversation));
    }
    if (action === 'messages' && method === 'POST')
      return service.message(record, await r.json(messageSchema, 40000));
    if (action === 'voice' && method === 'POST') {
      const { sdp } = await r.json(
        z.object({ sdp: z.string().min(1).max(100_000) }).strict(),
        110_000,
      );
      const { pi, caller, id: conversation } = await service.intake(record);
      const answer = await pi.voice(caller, { id: conversation, sdp }, { allowProfile: true });
      return { sdp: answer.sdp };
    }
    // Starts the intake's machine as the page opens, so the first answer does not wait for it.
    if (action === 'warm' && method === 'POST') {
      const { pi, caller, id: conversation } = await service.intake(record);
      return customerChat(
        await pi.warm(caller, { requestId: randomUUID(), conversationId: conversation }),
      );
    }
    if (action === 'stop' && method === 'POST') {
      const { pi, caller, id: conversation } = await service.intake(record);
      return customerChat(await pi.stop(caller, conversation));
    }
    if (action === 'events' && method === 'GET') {
      const { pi, caller, id: conversation } = await service.intake(record);
      await pi.authorizeStream(caller, conversation);
      check(!res.destroyed, 'pi_unavailable', 'Connection closed', 503);
      const held = [...open.values()].filter((request) => request === record.id);
      check(held.length < streamsPerRequest, 'pi_stream_busy', 'Too many chats are open', 429);
      open.set(res, record.id);
      try {
        await serveEvents(req, res, {
          rotateMs: 20_000,
          ...piLiveView(pi, caller, conversation, customerChat),
        });
      } finally {
        open.delete(res);
      }
      return;
    }
    check(false, 'not_found', 'Route not found', 404);
  };
  return (...[req, res, r]: Parameters<MountHandler>) =>
    route.test(r.url.pathname) ? handle(req, res, r) : undefined;
}
