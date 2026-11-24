/** Model ids displayed consistently with the composer. */
export const modelName = (id: string) =>
  id
    .replace(/^claude-/, '')
    .replace(/^gpt/i, 'GPT')
    .split('-')
    .reduce<string[]>(
      (words, part) =>
        /^\d+$/.test(part) && /\d$/.test(words.at(-1) ?? '')
          ? [...words.slice(0, -1), `${words.at(-1)}.${part}`]
          : [...words, part],
      [],
    )
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ')
    .replace(/^GPT (\d)/, 'GPT-$1');
