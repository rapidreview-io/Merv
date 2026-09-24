import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Caller } from '@merv/contracts';

export interface PiApiProvider {
  stream(caller: Caller, id: string, req: IncomingMessage, res: ServerResponse): Promise<void>;
}
