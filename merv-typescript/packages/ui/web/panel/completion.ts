/** Only the word being typed can open a suggestion, never an address or a later slash. Codex's
 *  skills are $words, which may come anywhere in a message. */
export function completion(text: string, caret: number, skills = false) {
  const before = text.slice(0, caret);
  const command =
    /^\/([^\s]*)$/.exec(before) ?? (skills ? /(?:^|\s)\$([^\s$]*)$/.exec(before) : null);
  const file = /(?:^|\s)@([^\s@]*)$/.exec(before);
  const match = command ?? file;
  if (!match) return undefined;
  const q = match[1];
  const start = caret - q.length - 1;
  const rest = /^\S*/.exec(text.slice(caret))![0];
  return {
    kind: command ? ('command' as const) : ('file' as const),
    q,
    start,
    end: caret + rest.length,
  };
}
