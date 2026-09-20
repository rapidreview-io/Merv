import { check } from '@merv/contracts';

const identifierPart = /[a-zA-Z0-9_$\u0080-\uffff]/;

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
        char === "'" && /[eE]/.test(sql[i - 1] ?? '') && !identifierPart.test(sql[i - 2] ?? '');
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
      const end = sql.slice(i + 2).search(/[\r\n]/);
      i = end < 0 ? sql.length : i + end + 3;
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
    } else if (char === '$' && !identifierPart.test(sql[i - 1] ?? '')) {
      const delimiter = /^(\$[a-zA-Z_\u0080-\uffff][a-zA-Z0-9_\u0080-\uffff]*\$|\$\$)/.exec(
        sql.slice(i),
      )?.[0];
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
