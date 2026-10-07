import type { ContextRecipeDefinition } from '@merv/contracts';
import { TASK_TYPES } from '@merv/tasks/definitions';

const work = TASK_TYPES.find((type) => type.name === 'task.work')!;

/** A work task type with two custom context inputs, which no registered type has: a test registers
 * it to exercise task.create's contextInputs and how a context renders them. */
export const inputsTaskType: ContextRecipeDefinition = {
  ...work,
  name: 'fixture.inputs',
  version: 1,
  recipe: {
    ...work.recipe,
    sections: [
      ...work.recipe.sections,
      { key: 'experiments', title: 'Selected completed experiments', required: true },
      { key: 'projectKnowledge', title: 'Current project knowledge', required: true },
    ],
  },
};
