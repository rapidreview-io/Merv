// Generated from packages/board/src/attach-client.ts; do not edit.

// packages/board/src/attach-client.ts
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

// packages/board/src/transcript.ts
var count = (tally, key) => {
  tally[key] = (tally[key] ?? 0) + 1;
};
var SECRETS = [
  [
    "private-key",
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g
  ],
  ["url-password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'\\]+:[^\s/@"'\\]+@/gi],
  ["jwt", /\beyJ[\w-]{8,}\.[\w-]{8,}(\.[\w-]+)?/g],
  [
    "api-key",
    /\b(sk|pk|rk)[-_](?:ant-|live-|test-|proj-|live_|test_)?[\w-]{16,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bgh[pousr]_\w{20,}|\bgithub_pat_\w{20,}|\bglpat-[\w-]{16,}|\bxox[abeoprs]-[\w-]{10,}|\bAIza[\w-]{30,}|\bya29\.[\w-]{20,}|\bnpm_\w{20,}|\bhf_\w{20,}|\bwhsec_\w{16,}|\bSG\.[\w-]{16,}\.[\w-]{16,}|\bmk_\w{16,}|\bcfut_\w{16,}|\bdop_v1_\w{16,}|\bre_[A-Za-z0-9]{16,}\w*/g
  ],
  ["authorization", /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi],
  [
    "named-secret",
    /((?:pass(?:word|wd|phrase)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credentials?|authorization|cookie|session[-_]?key)[\w-]*\\*["']?\s*(?:[:=]|=>)\s*(\\*["']))(?!\[redacted)(?:(?!\2)[^\n]){1,300}?(?=\2)/gi
  ],
  [
    "named-secret",
    /((?:pass(?:word|wd|phrase)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credentials?|authorization|cookie|session[-_]?key)[\w-]*\\*["']?\s*(?:[:=]|=>)\s*(?:\\*["'])?)(?!\[redacted|\$\{?|<|process\.|env\.|true\b|false\b|null\b|undefined\b)[^\s"'\\,;)}\]]{6,}/gi
  ],
  ["email", /\b[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g]
];
var LONG = /(?<![\w/+-])(?:[A-Fa-f0-9]{48,}|[A-Za-z0-9_+=-]{40,})(?![\w/+-])/g;
var keyLike = (run) => /^[A-Fa-f0-9]+$/.test(run) && run.length >= 48 || /\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run);
var redact = (text, tally = {}) => {
  let out = text;
  for (const [kind, pattern] of SECRETS)
    out = out.replace(pattern, (match, keep) => {
      count(tally, kind);
      return `${kind === "named-secret" ? keep : ""}[redacted:${kind}]`;
    });
  return out.replace(LONG, (run) => {
    if (!keyLike(run)) return run;
    count(tally, "long-token");
    return "[redacted:long-token]";
  });
};
var MOST_BYTES = 15 * 1024 * 1024;
var PAUSE_MS = 30 * 6e4;

// packages/board/src/attach-client.ts
var [HOOK_MS, QUIET_MS] = [600, 3e4];
var SENT = 200;
var FIELDS = ["command", "file_path", "path", "pattern", "url", "description", "query"];
var HOSTED = "https://experiments.rapidreview.io";
var fileOf = (data, session) => join(data, "attached", `${session.replace(/[^\w-]/g, "")}.json`);
var attachedTo = (data = "", session = "") => {
  try {
    return JSON.parse(readFileSync(fileOf(data, session), "utf8"));
  } catch {
    return void 0;
  }
};
var short = (text) => redact(String(text ?? "")).slice(0, SENT);
var post = async ({ url, token }, path, body, ms) => {
  const answer = await fetch(`${url}/board-attach${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    ...ms && { signal: AbortSignal.timeout(ms) }
  });
  if (!answer.ok && !ms) throw new Error((await answer.text()).slice(0, 300));
  return answer.ok ? await answer.json() : {};
};
var noted = (board, hand) => `[board ${board}: the person watching this board just did this by hand, to steer you without typing: ${hand.join("; ")}. A stroke across a step of your work means they dropped it: carry on without it. A circle means focus there. The question mark only means software read a stroke, so ask only if acting on it could not easily be undone. Say in one line what you changed.]`;
function stepOf(input) {
  const event = input.hook_event_name;
  const lane = input.agent_type ? { lane: String(input.agent_type) } : {};
  if (event === "UserPromptSubmit") return { kind: "person", text: short(input.prompt), ask: true };
  if (event === "Stop") return { kind: "say", text: short(input.last_assistant_message) };
  if (event === "SessionEnd") return { kind: "say", text: "", ended: true };
  const tool = input.tool_input ?? {};
  const field = FIELDS.find((name) => tool[name] !== void 0);
  const done = event !== "PreToolUse";
  return {
    kind: "call",
    key: input.tool_use_id,
    tool: input.tool_name,
    text: field ? short(tool[field]) : "",
    ...lane,
    ...done && { done: true, ask: true },
    ...event === "PostToolUseFailure" && { failed: true }
  };
}
async function hook() {
  let raw = "";
  for await (const part of process.stdin) raw += part;
  const input = JSON.parse(raw);
  const data = process.env.CLAUDE_PLUGIN_DATA;
  const attached = attachedTo(data, input.session_id);
  if (!attached) return;
  const file = fileOf(data, input.session_id);
  const ended = input.hook_event_name === "SessionEnd";
  if (ended) rmSync(file, { force: true });
  if ((statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0) > Date.now()) return;
  try {
    const { board, hand } = await post(attached, "/event", stepOf(input), HOOK_MS);
    if (hand?.length)
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: input.hook_event_name,
            additionalContext: noted(board, hand)
          }
        })
      );
  } catch {
    const until = new Date(Date.now() + QUIET_MS);
    if (!ended) utimesSync(file, until, until);
  }
}
async function pair([code = "", session = "", data = ""]) {
  const url = (process.env.BOARD_URL ?? HOSTED).replace(/\/$/, "");
  const name = `Claude ${basename(process.cwd())}`.replace(/[^\w .-]/g, "").slice(0, 40);
  const answer = await fetch(`${url}/board-attach/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name }),
    signal: AbortSignal.timeout(1e4)
  });
  if (!answer.ok) return console.log(`Not attached: ${(await answer.text()).slice(0, 200)}`);
  const { token, board, title } = await answer.json();
  mkdirSync(join(data, "attached"), { recursive: true, mode: 448 });
  const file = fileOf(data, session);
  writeFileSync(file, JSON.stringify({ url, token, board }), { mode: 384 });
  console.log(
    `Attached to board "${title}" (${board}) as ${name}; board_read and board_write always act on it. Sent while attached: prompts and Claude's closing words (first ${SENT} characters), tool names with their command, path, pattern or URL (first ${SENT} characters), and what is drawn. Never tool output or file contents.`
  );
}
function mcp() {
  const session = process.env.CLAUDE_CODE_SESSION_ID;
  const data = process.env.CLAUDE_PLUGIN_DATA;
  const url = (process.env.BOARD_URL ?? HOSTED).replace(/\/$/, "");
  const say = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}
`);
  const text = (words) => ({ isError: true, content: [{ type: "text", text: words }] });
  const listing = fetch(`${url}/board-attach/tools`, { signal: AbortSignal.timeout(5e3) }).then((answer) => answer.json()).catch(() => ({ instructions: "", tools: [] }));
  createInterface({ input: process.stdin }).on("line", (line) => {
    const { id, method, params } = JSON.parse(line);
    void (async () => {
      if (method === "initialize") {
        const { instructions } = await listing;
        say(id, {
          protocolVersion: params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "board", version: "0.1.0" },
          instructions
        });
      } else if (method === "tools/list") {
        const { tools } = await listing;
        say(id, { tools: tools.map((tool) => ({ ...tool, name: tool.name.replace(".", "_") })) });
      } else if (method === "tools/call") {
        const attached = attachedTo(data, session);
        if (!attached)
          return say(id, text("Not attached: get a code from the board and run /board:pair CODE"));
        const name = String(params.name).replace("_", ".");
        say(
          id,
          await post(attached, "/call", { name, input: params.arguments ?? {} }).catch(
            (error) => text(error.message)
          )
        );
      } else if (id !== void 0) say(id, {});
    })();
  });
}
var [mode, ...rest] = process.argv.slice(2);
if (mode === "mcp") mcp();
else (mode === "pair" ? pair(rest) : hook()).catch(() => void 0);
