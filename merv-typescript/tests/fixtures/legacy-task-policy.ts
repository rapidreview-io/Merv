import assert from 'node:assert/strict';
import type {
  State,
  WorkflowDefinition,
  WorkflowExecutionPolicy,
  WorkflowPolicy,
} from '@merv/contracts';

/**
 * These fixtures seed historical Task rows after the current application has initialized.
 * Reuse its immutable manifests while the Tasks provider is briefly unloaded; removing
 * those declarations would be a version change. Restore Tasks before using the seeded work.
 */
export async function legacyTaskPolicy(
  state: State,
  definition: WorkflowDefinition,
): Promise<WorkflowPolicy> {
  assert.equal(definition.name, 'task');
  const manifests = await state.read(
    async (sql) =>
      await sql.all<{ state: string; manifest_json: string }>(
        'SELECT state,manifest_json FROM wf_execution_policies WHERE workflow=? AND version=?',
        definition.name,
        definition.version,
      ),
  );
  const refuse = (): never => {
    throw new Error('Restore the Tasks provider before using seeded legacy work');
  };
  return {
    successStates: ['done'],
    actions: [...new Set(definition.edges.map((edge) => edge.action))].map((action) => ({
      name: action,
      states: definition.edges.filter((edge) => edge.action === action).map((edge) => edge.from),
      tool: 'fixture.unavailable',
      instruction: 'Restore the Tasks provider.',
      transitions: [action],
      check: refuse,
    })),
    assignments: definition.states
      .filter((name) => !definition.terminal.includes(name))
      .map((name) => {
        const row = manifests.find((manifest) => manifest.state === name);
        assert.ok(row, `Expected the existing task@${definition.version}/${name} manifest`);
        const execution = JSON.parse(row.manifest_json) as WorkflowExecutionPolicy | null;
        assert.ok(execution, 'The current Tasks provider must have pinned a fixed policy');
        return { state: name, execution, check: refuse, build: refuse, references: refuse };
      }),
  };
}
