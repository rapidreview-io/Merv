/** A native tool's name as the model calls it: its dots become underscores, and the agent's own
 * machine.switch is switch_machine. */
export const piModelToolName = (nativeName: string): string =>
  nativeName === 'machine.switch' ? 'switch_machine' : nativeName.replaceAll('.', '_');

/** The agent library's own terminal tools, offered (by these names) only to a profile with a
 * shell: commands and files in the conversation's own folder on its machine, as Fleet's task
 * agents have them. */
export const PI_SHELL_TOOLS = ['bash', 'read', 'write', 'ls', 'grep'] as const;
