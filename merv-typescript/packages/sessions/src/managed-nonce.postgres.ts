export const managedNoncePostgresMigration = `
ALTER TABLE session_managed_runners ADD COLUMN worker_nonce_hash TEXT
  CHECK(worker_nonce_hash IS NULL OR worker_nonce_hash ~ '^[0-9a-f]{64}$');
CREATE OR REPLACE FUNCTION session_managed_runners_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.allocation_id IS DISTINCT FROM OLD.allocation_id OR NEW.epoch IS DISTINCT FROM OLD.epoch OR
     NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.source_json IS DISTINCT FROM OLD.source_json OR
     NEW.source_hash IS DISTINCT FROM OLD.source_hash OR NEW.runtime_profile_id IS DISTINCT FROM OLD.runtime_profile_id OR
     NEW.platform_json IS DISTINCT FROM OLD.platform_json OR NEW.capabilities_json IS DISTINCT FROM OLD.capabilities_json OR
     NEW.enrollment_hash IS DISTINCT FROM OLD.enrollment_hash OR
     NEW.enrollment_expires_at IS DISTINCT FROM OLD.enrollment_expires_at OR NEW.control_expires_at IS DISTINCT FROM OLD.control_expires_at OR
     NEW.created_at IS DISTINCT FROM OLD.created_at OR
     (OLD.worker_nonce_hash IS NOT NULL AND NEW.worker_nonce_hash IS DISTINCT FROM OLD.worker_nonce_hash) OR
     (NEW.control_hash IS DISTINCT FROM OLD.control_hash AND
       (OLD.worker_nonce_hash IS NOT NULL OR NEW.worker_nonce_hash IS NULL)) OR
     (OLD.runner_id IS NOT NULL AND NEW.runner_id IS DISTINCT FROM OLD.runner_id) OR
     (OLD.bound_session_id IS NOT NULL AND NEW.bound_session_id IS DISTINCT FROM OLD.bound_session_id) OR
     (OLD.runner_released_at IS NOT NULL AND NEW.runner_released_at IS DISTINCT FROM OLD.runner_released_at) THEN
    RAISE EXCEPTION USING MESSAGE = 'Managed runner binding is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
`;
