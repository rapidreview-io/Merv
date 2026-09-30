import Lake
open Lake DSL

package workflow_model where
  moreLeanArgs := #["-DwarningAsError=true"]

lean_lib Workflow

@[default_target]
lean_lib Invariants

lean_lib Admission

lean_lib ReviewClaims

lean_lib SessionOwnership

lean_lib WorkflowDependencies

lean_lib IdentityCredentials

lean_lib ScopeAuthority

lean_lib Fleet

lean_lib FleetWorkflow

@[default_target]
lean_lib FleetLease

lean_lib FleetRelease

lean_lib RunnerOwnership

lean_lib RunnerSettlement

lean_lib BackendAuthority

lean_lib BackendEvents

lean_lib BackendStorage

@[default_target]
lean_lib BackendProviderBoundary

lean_lib BackendRelay

@[default_target]
lean_exe backend_relay_model where
  root := `BackendRelayMain

@[default_target]
lean_exe backend_authority_model where
  root := `BackendAuthorityMain

@[default_target]
lean_exe backend_events_model where
  root := `BackendEventsMain

@[default_target]
lean_exe backend_storage_model where
  root := `BackendStorageMain

@[default_target]
lean_exe runner_ownership_model where
  root := `RunnerOwnershipMain

@[default_target]
lean_exe runner_settlement_model where
  root := `RunnerSettlementMain

@[default_target]
lean_exe fleet_model where
  root := `FleetMain

@[default_target]
lean_exe fleet_workflow_model where
  root := `FleetWorkflowMain

@[default_target]
lean_exe fleet_lease_model where
  root := `FleetLeaseMain

@[default_target]
lean_exe fleet_release_model where
  root := `FleetReleaseMain

@[default_target]
lean_exe identity_credentials_model where
  root := `IdentityCredentialsMain

@[default_target]
lean_exe scope_authority_model where
  root := `ScopeAuthorityMain

@[default_target]
lean_exe sessions_ownership_model where
  root := `SessionOwnershipMain

@[default_target]
lean_exe workflow_dependencies_model where
  root := `WorkflowDependenciesMain

@[default_target]
lean_exe review_claim_model where
  root := `ReviewClaimsMain

@[default_target]
lean_exe workflow_admission_model where
  root := `AdmissionMain

@[default_target]
lean_exe workflow_model where
  root := `Main
