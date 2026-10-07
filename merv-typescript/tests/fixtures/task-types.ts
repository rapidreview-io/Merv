import type { ContextRecipeDefinition } from '@merv/contracts';
import type { TaskService } from '@merv/tasks';

/**
 * Registers an extra task type the way Tasks registers its own at start. Tasks offers no such
 * call to other plugins: only tests add types.
 */
export const registerTaskType = (tasks: unknown, definition: ContextRecipeDefinition) =>
  (tasks as TaskService).registerType(definition);
