import { useMemo, useState } from 'react';

/**
 * A CSV or TSV file, read as the table it is. The parser follows RFC 4180: a field
 * in double quotes may hold the separator, a newline, and a quote written twice.
 * A file whose rows do not all have as many fields as its head, or whose quote is
 * never closed, is not a table, and stays the text it was.
 */

/** Rows of fields, or nothing where the text is not one rectangular table. */
export function parseDelimited(text: string, separator: ',' | '\t'): string[][] | undefined {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let at = 0;
  const end = () => {
    row.push(field);
    field = '';
  };
  while (at < text.length) {
    const char = text[at]!;
    if (char === '"' && field === '') {
      // A quoted field runs to the quote not written twice.
      for (at++; ; at++) {
        if (at >= text.length) return undefined;
        if (text[at] === '"') {
          if (text[at + 1] !== '"') break;
          at++;
        }
        field += text[at];
      }
      at++;
      const after = text[at];
      if (after !== undefined && after !== separator && after !== '\n' && after !== '\r')
        return undefined;
      continue;
    }
    if (char === separator) end();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[at + 1] === '\n') at++;
      end();
      rows.push(row);
      row = [];
    } else field += char;
    at++;
  }
  if (field || row.length) {
    end();
    rows.push(row);
  }
  // Blank lines at the end are the end of the file, not rows of one empty field.
  while (
    rows.length > 1 &&
    rows[rows.length - 1]!.join('') === '' &&
    rows[rows.length - 1]!.length === 1
  )
    rows.pop();
  const width = rows[0]?.length ?? 0;
  return width && rows.every((cells) => cells.length === width) ? rows : undefined;
}

/** How many rows are drawn at a time. */
const PAGE = 200;
const NUMBER = /^[-+]?(?:\d[\d,_]*\.?\d*|\.\d+)(?:e[-+]?\d+)?%?$|^(?:nan|-?inf)$/i;

/** A parsed table: its head stays in view, its rows are numbered, and a column of numbers is set flush right. */
export function DelimitedTable({ rows }: { rows: string[][] }) {
  const [shown, setShown] = useState(PAGE);
  const [head = [], ...body] = rows;
  const numeric = useMemo(
    () =>
      head.map((_, column) => {
        const cells = body.map((cells) => cells[column]!.trim()).filter(Boolean);
        return cells.length > 0 && cells.every((cell) => NUMBER.test(cell));
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows],
  );
  const rest = body.length - shown;
  return (
    <div className="table-file">
      <p className="table-file-size faint tabular">
        {body.length.toLocaleString()} {body.length === 1 ? 'row' : 'rows'} · {head.length}{' '}
        {head.length === 1 ? 'column' : 'columns'}
      </p>
      <div className="table-file-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col" className="table-file-index" aria-label="Row" />
              {head.map((cell, column) => (
                <th key={column} scope="col" className={numeric[column] ? 'num' : undefined}>
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.slice(0, shown).map((cells, index) => (
              <tr key={index}>
                <th scope="row" className="table-file-index">
                  {index + 1}
                </th>
                {cells.map((cell, column) => (
                  <td key={column} className={numeric[column] ? 'num' : undefined}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rest > 0 && (
        <button type="button" className="btn-text" onClick={() => setShown(shown + PAGE)}>
          Show {Math.min(PAGE, rest)} more
        </button>
      )}
    </div>
  );
}
