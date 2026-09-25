/** A native tool's name as the model calls it: its dots become underscores, and the agent's own
 * machine.switch is switch_machine. */
export const piModelToolName = (nativeName: string): string =>
  nativeName === 'machine.switch' ? 'switch_machine' : nativeName.replaceAll('.', '_');
