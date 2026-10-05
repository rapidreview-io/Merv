import { CodeBlock, AnsiText } from './code-block';
import { Markdown } from './markdown';

/**
 * A Jupyter notebook, read as its author saw it last: prose cells as documents,
 * code cells as code in the notebook's language with the count they ran at, and
 * what each printed under it. Nothing a notebook holds is run or handed to the
 * browser as HTML: an HTML or JavaScript output is shown as the text it is, and
 * an image is drawn only from the bytes the notebook itself carries.
 */

type Text = string | string[];
interface Output {
  output_type?: string;
  text?: Text;
  data?: Record<string, unknown>;
  traceback?: string[];
  ename?: string;
  evalue?: string;
}
interface Cell {
  cell_type?: string;
  source?: Text;
  execution_count?: number | null;
  outputs?: Output[];
}
export interface Notebook {
  cells: Cell[];
  language?: string;
}

const joined = (text: unknown) =>
  Array.isArray(text) ? text.join('') : typeof text === 'string' ? text : '';

/** A notebook's cells and language, or nothing where the text is not a notebook. */
export function readNotebook(content: string): Notebook | undefined {
  try {
    const book = JSON.parse(content) as {
      cells?: unknown;
      metadata?: { language_info?: { name?: unknown }; kernelspec?: { language?: unknown } };
    };
    if (!Array.isArray(book?.cells)) return undefined;
    const language = book.metadata?.language_info?.name ?? book.metadata?.kernelspec?.language;
    return {
      cells: book.cells.filter((cell): cell is Cell => !!cell && typeof cell === 'object'),
      ...(typeof language === 'string' ? { language } : {}),
    };
  } catch {
    return undefined;
  }
}

/** The images a notebook may carry, drawn from its own base64. SVG is not among them. */
const IMAGES = ['image/png', 'image/jpeg', 'image/gif'];
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function OutputView({ output }: { output: Output }) {
  if (output.output_type === 'stream')
    return (
      <pre className="nb-output">
        <AnsiText text={joined(output.text)} />
      </pre>
    );
  if (output.output_type === 'error')
    return (
      <pre className="nb-output nb-output--error">
        <AnsiText
          text={
            output.traceback?.join('\n') ?? `${output.ename ?? 'Error'}: ${output.evalue ?? ''}`
          }
        />
      </pre>
    );
  const data = output.data ?? {};
  const image = IMAGES.find((type) => typeof data[type] === 'string' || Array.isArray(data[type]));
  const bytes = image && joined(data[image]).replace(/\s+/g, '');
  if (image && bytes && BASE64.test(bytes))
    return <img className="nb-image" src={`data:${image};base64,${bytes}`} alt="Cell output" />;
  // Plain text says what an HTML table or a widget would; failing that, the markup is shown as text.
  const plain = data['text/plain'];
  if (plain !== undefined)
    return (
      <pre className="nb-output">
        <AnsiText text={joined(plain)} />
      </pre>
    );
  const shown = ['text/html', 'application/javascript', 'text/markdown', 'text/latex'].find(
    (type) => data[type] !== undefined,
  );
  return shown ? (
    <div className="nb-markup">
      <span className="faint">{shown}, shown as text</span>
      <pre className="nb-output">{joined(data[shown])}</pre>
    </div>
  ) : null;
}

export function NotebookView({ notebook }: { notebook: Notebook }) {
  return (
    <div className="notebook">
      {notebook.cells.map((cell, index) => {
        const source = joined(cell.source);
        if (cell.cell_type === 'markdown')
          return (
            <div key={index} className="nb-cell nb-cell--markdown">
              <Markdown source={source} under={3} />
            </div>
          );
        if (cell.cell_type !== 'code')
          return (
            <pre key={index} className="nb-cell nb-output">
              {source}
            </pre>
          );
        return (
          <div key={index} className="nb-cell">
            <span className="nb-count faint tabular">
              [{typeof cell.execution_count === 'number' ? cell.execution_count : ' '}]
            </span>
            <div className="nb-body">
              <CodeBlock code={source} lang={notebook.language} numbered={false} />
              {(cell.outputs ?? []).map((output, at) => (
                <OutputView key={at} output={output} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
