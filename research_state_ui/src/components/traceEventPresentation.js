// One line per provider event for the trace peek. Provider streams differ
// (Claude/Gemini/Qwen stream-json, Codex --json, Hermes export, custom JSONL);
// this is a best-effort summary that never throws and always fits one row.

const MAX_TEXT = 220;

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function blockText(block) {
  if (!block || typeof block !== 'object') return oneLine(block);
  if (block.type === 'text') return oneLine(block.text);
  if (block.type === 'tool_use') return `⚙ ${block.name || 'tool'}${block.input ? ` ${oneLine(JSON.stringify(block.input)).slice(0, 80)}` : ''}`;
  if (block.type === 'tool_result') {
    const content = Array.isArray(block.content)
      ? block.content.map((item) => (item?.text ?? item)).join(' ')
      : block.content;
    return `↩ ${oneLine(content) || 'result'}`;
  }
  if (block.type === 'thinking') return '… thinking';
  return oneLine(block.text || block.content || JSON.stringify(block));
}

export function summarizeTraceEvent(event) {
  if (!event || typeof event !== 'object') {
    return { kind: 'event', text: oneLine(event), tone: 'plain' };
  }
  if (event.truncated) return { kind: 'large event', text: oneLine(event.preview), tone: 'plain' };
  if (typeof event.raw === 'string') return { kind: 'stdout', text: oneLine(event.raw), tone: 'plain' };

  const kind = oneLine(event.type || event.event || event.kind || event.subtype || 'event').slice(0, 40);
  let tone = 'plain';
  let text = '';

  if (event.item && typeof event.item === 'object') {
    // Codex --json: item.completed / item.started with a typed item.
    const item = event.item;
    const itemType = String(item.type || '');
    if (itemType === 'agent_message' || itemType === 'message') text = oneLine(item.text || item.content);
    else if (itemType === 'command_execution') { text = `$ ${oneLine(item.command)}${item.exit_code != null ? ` → exit ${item.exit_code}` : ''}`; tone = 'tool'; }
    else if (itemType === 'mcp_tool_call') { text = `⚙ ${item.server ? `${item.server}.` : ''}${item.tool || 'tool'}${item.status ? ` · ${item.status}` : ''}`; tone = 'tool'; }
    else if (itemType === 'reasoning') { text = '… reasoning'; }
    else if (itemType === 'file_change' || itemType === 'patch') { text = `✎ ${oneLine(item.path || item.summary || 'file change')}`; tone = 'tool'; }
    else text = oneLine(item.text || item.summary || JSON.stringify(item));
    if (item.error) tone = 'error';
    return { kind: `${kind}${itemType ? ` · ${itemType}` : ''}`.slice(0, 48), text, tone };
  }
  if (event.message && typeof event.message === 'object') {
    // Claude / Gemini / Qwen stream-json.
    const content = event.message.content;
    const blocks = Array.isArray(content) ? content : [content];
    text = blocks.map(blockText).filter(Boolean).join(' · ');
    if (blocks.some((block) => block?.type === 'tool_use' || block?.type === 'tool_result')) tone = 'tool';
    if (kind === 'assistant') tone = tone === 'tool' ? 'tool' : 'text';
  } else if (typeof event.result === 'string') {
    text = oneLine(event.result);
    tone = 'final';
  } else if (event.usage && (kind.includes('completed') || kind === 'result')) {
    const usage = event.usage;
    text = `usage: ${oneLine(JSON.stringify(usage)).slice(0, 120)}`;
    tone = 'final';
  } else if (event.error) {
    text = oneLine(typeof event.error === 'string' ? event.error : event.error.message || JSON.stringify(event.error));
    tone = 'error';
  } else if (event.text || event.content) {
    text = oneLine(event.text || event.content);
  } else {
    const compact = { ...event };
    delete compact.type; delete compact.event; delete compact.kind;
    text = oneLine(JSON.stringify(compact));
  }
  if (/error|fail/i.test(kind)) tone = 'error';
  if (kind === 'result' || /turn[._]completed|session_end|final/.test(kind)) tone = tone === 'error' ? 'error' : 'final';
  return { kind, text, tone };
}

export function traceUpdatedLabel(updatedAt, now = Date.now()) {
  const at = Date.parse(updatedAt || '');
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(Math.round((now - at) / 1000), 0);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
