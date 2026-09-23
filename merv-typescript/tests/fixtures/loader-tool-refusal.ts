import type { Context } from 'cordis';
import { MervError } from '@merv/contracts';
import type {} from '@merv/api/types';

/** Refuses every Tasks tool registration, as a broken tool definition would be refused. */
export default {
  name: 'fixture-tool-refusal',
  inject: ['tools'],
  apply(ctx: Context) {
    const tools = ctx.tools;
    const register = tools.register.bind(tools);
    tools.register = (definition) => {
      if (definition.name.startsWith('task.'))
        throw new MervError('invalid_tool', 'Tool refused by the test registry');
      return register(definition);
    };
    ctx.effect(() => () => {
      tools.register = register;
    });
  },
};
