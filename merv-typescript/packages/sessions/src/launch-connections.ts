/** The provider receives a detached immutable snapshot, never mutable session state. */
export function freezeLaunchSnapshot<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeLaunchSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
