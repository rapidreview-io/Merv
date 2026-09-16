import { check } from '@merv/contracts';

/** Bind markers only: SQL strings, identifiers, comments and function bodies stay intact. */
export function postgresParameters(sql: string, expected: number): string {
  let result = '';
  let count = 0;
  let i = 0;
  while (i < sql.length) {
    const start = i;
    const char = sql[i];
    if (char === "'" || char === '"') {
      const escaped =
        char === "'" && /[eE]/.test(sql[i - 1] ?? '') && !/[a-zA-Z0-9_$]/.test(sql[i - 2] ?? '');
      i++;
      while (i < sql.length) {
        if (escaped && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i++] === char) {
          if (sql[i] === char) i++;
          else break;
        }
      }
    } else if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end + 1;
    } else if (sql.startsWith('/*', i)) {
      i += 2;
      let depth = 1;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      }
    } else if (char === '$') {
      const delimiter = /^(\$[a-zA-Z_][a-zA-Z0-9_]*\$|\$\$)/.exec(sql.slice(i))?.[0];
      if (delimiter) {
        const end = sql.indexOf(delimiter, i + delimiter.length);
        i = end < 0 ? sql.length : end + delimiter.length;
      } else i++;
    } else if (char === '?') {
      result += `$${++count}`;
      i++;
      continue;
    } else i++;
    result += sql.slice(start, i);
  }
  check(
    count === expected,
    'invalid_sql_parameters',
    'SQL bind marker count does not match parameters',
  );
  return result;
}
