import { customerPage } from './customer-page.js';
import type { CustomerService } from './service.js';

/** The customer app the UI bundle builds (web/customer.html), or null where it is not built. */
export type CustomerApp = () => Promise<string | null | undefined>;

/** The service_experiment version the request runs on, or null while it has none. */
async function versionOf(service: CustomerService, id: string): Promise<number | null> {
  const record = await service.store.get(id);
  if (!record.projectId || !record.experimentId) return null;
  const caller = await service.caller(record);
  const exp = await service.domain.get(caller, record.experimentId, service.store.state.ambient);
  return exp.workflow.version;
}

/**
 * The page at /customer-experiments/r/:id. Requests on service_experiment@3 open the customer
 * app (sign-in, chat, plan, files); earlier versions, and any request the app cannot be served
 * for, keep the self-contained page they were made with. The app reads its capability and
 * request from the address, as that page does, so the same HTML serves every request.
 */
export async function customerDocument(
  service: CustomerService,
  id: string,
  app?: CustomerApp,
): Promise<string> {
  const version = app ? await versionOf(service, id).catch(() => null) : null;
  const html = version !== null && version >= 3 ? await app!().catch(() => null) : null;
  return html ?? customerPage(id);
}
