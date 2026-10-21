import { createRequire } from 'node:module';

/** Codex stand-in uses a real TOML parser, including for deciding whether a header is inside a
 * multiline string. It preserves the other tables so text-preservation assertions are useful. */
export function codexStandIn() {
  const require = createRequire(import.meta.url);
  return `
const { parse } = require(${JSON.stringify(require.resolve('smol-toml'))});
const dir = process.env.CODEX_HOME || path.join(process.env.HOME, '.codex');
const file = path.join(dir, 'config.toml');
const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
let config;
try { config = parse(text); } catch { process.exit(1); }
const server = config.mcp_servers?.[args[2]];
if (args[1] === 'get') {
  if (!server) process.exit(1);
  process.stdout.write(JSON.stringify({ transport: { type: 'stdio', args: [], ...server } }));
}
if (args[1] === 'remove') {
  const lines = text.match(/[^\\n]*\\n|[^\\n]+$/g) || [];
  let prefix = '', keep = true, after = '';
  for (const line of lines) {
    if (line.trimStart().startsWith('[')) {
      try {
        parse(prefix);
        const table = parse(line);
        keep = !Object.hasOwn(table.mcp_servers || {}, args[2]);
      } catch { /* Part of a multiline string. */ }
    }
    if (keep) after += line;
    prefix += line;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, after, { mode: 0o600 });
}
process.exit(0);
`;
}
