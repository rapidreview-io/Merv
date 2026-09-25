const names: Readonly<Record<string, string>> = Object.freeze({
  'project.get': 'project_get',
  'task.list': 'task_list',
  'artifact.list': 'artifact_list',
  'artifact.get': 'artifact_get',
  'artifact.read': 'artifact_read',
  'machine.switch': 'switch_machine',
});

export function piModelToolName(nativeName: string): string {
  if (!Object.hasOwn(names, nativeName)) throw new Error('Unsupported Pi tool');
  return names[nativeName];
}
