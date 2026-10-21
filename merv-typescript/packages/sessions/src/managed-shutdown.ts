import { z } from 'zod';
import { oidPattern } from '@merv/contracts';

/** A planned host release is independent of a session's ordinary stop receipt. */
export const managedShutdownMigration = `
CREATE TABLE session_managed_shutdowns (
  allocation_id TEXT PRIMARY KEY REFERENCES session_managed_runners(allocation_id),
  epoch BIGINT NOT NULL,
  requested_at TEXT NOT NULL,
  receipt_json TEXT CHECK(receipt_json IS JSON),
  acknowledged_at TEXT,
  CHECK ((receipt_json IS NULL) = (acknowledged_at IS NULL))
);
CREATE FUNCTION session_managed_shutdown_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF TG_OP='DELETE' OR NEW.allocation_id IS DISTINCT FROM OLD.allocation_id OR
    NEW.epoch IS DISTINCT FROM OLD.epoch OR NEW.requested_at IS DISTINCT FROM OLD.requested_at OR
    (OLD.receipt_json IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION USING MESSAGE='Managed shutdown receipts are immutable', ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER session_managed_shutdown_immutable BEFORE UPDATE OR DELETE ON session_managed_shutdowns
FOR EACH ROW EXECUTE FUNCTION session_managed_shutdown_guard();
`;
const id = z.string().min(1).max(200);
const oid = z.string().regex(oidPattern);
export const shutdownReceiptSchema = z
  .strictObject({
    captures: z
      .array(
        z.strictObject({ sessionId: id, unitId: id, headOid: oid, treeOid: oid, operationId: id }),
      )
      .max(256),
    empty: z.boolean(),
  })
  .refine(
    (value) => value.empty === (value.captures.length === 0),
    'Empty must describe the captures',
  );
export type ManagedShutdownReceipt = z.infer<typeof shutdownReceiptSchema>;
export interface ManagedShutdownControl {
  requested: boolean;
  acknowledged: boolean;
}
