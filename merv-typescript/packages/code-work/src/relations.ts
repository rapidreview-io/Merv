import {
  mapAsync,
  type Transaction,
  type WorkflowDependency,
  type Workflows,
} from '@merv/contracts';

/**
 * A dependency as code-work reads it: the workflow's own classification plus whether any
 * state of that workflow version declared a workspace. The second is read from the pinned
 * execution manifests, so it holds with the owning plugin unloaded.
 */
export interface WorkflowProviderDependency extends WorkflowDependency {
  declaresWorkspace: boolean;
}
export interface WorkflowProviderRelations {
  instance: WorkflowProviderDependency;
  dependencies: WorkflowProviderDependency[];
  dependents: WorkflowProviderDependency[];
}

/**
 * A unit and both directions of its edges, each with its version's workspace fact. A unit is
 * known by the generic name and id Workflows gives it; its data belongs to the domain that owns
 * it. Null when the project holds no such instance.
 */
export async function providerRelations(
  workflows: Workflows,
  projectId: string,
  unitId: string,
  tx: Transaction,
): Promise<WorkflowProviderRelations | null> {
  const relations = await workflows.relations(projectId, unitId, tx);
  if (!relations) return null;
  // Any manifest of the version counts, and one that names no mode declares none.
  const extend = async (item: WorkflowDependency): Promise<WorkflowProviderDependency> => ({
    ...item,
    declaresWorkspace: Object.values(
      (await workflows.pinned(item.workflow, item.version, tx))?.execution ?? {},
    ).some((manifest) => (manifest?.workspace?.mode ?? 'none') !== 'none'),
  });
  const { data: _data, ...instance } = relations.instance;
  return {
    instance: await extend(instance),
    dependencies: await mapAsync(relations.dependencies, extend),
    dependents: await mapAsync(relations.dependents, extend),
  };
}
