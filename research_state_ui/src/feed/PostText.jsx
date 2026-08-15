import { Fragment } from 'react';
import EntityChip from '../components/EntityChip';

// The structure the feed pulls out of plain prose, mirroring the brain's
// refs.py: entity ids become chips, arXiv/DOI/URLs become links, **bold** and
// `code` render. Order in the alternation matters — longer, more specific
// tokens first — and every branch is anchored so a bare "exp_" in a word is
// left alone.
const TOKEN = new RegExp(
  [
    String.raw`\*\*([^*\n]+?)\*\*`, // 1 bold
    '`([^`\\n]+?)`', // 2 code
    String.raw`(?<![A-Za-z0-9_])((?:exp|claim|res|rver|syn|rev|lit|paper)_[0-9a-f]{6,32})(?![A-Za-z0-9_])`, // 3 entity
    String.raw`\b(arXiv:\s?\d{4}\.\d{4,5}(?:v\d+)?)\b`, // 4 arXiv
    String.raw`\b(doi:\s?10\.\d{4,9}/[^\s,;)\]]+)`, // 5 doi
    String.raw`(https?://[^\s<>()\[\]"']+)`, // 6 url
    String.raw`(?<![A-Za-z0-9*])\*([^*\s][^*\n]*?)\*(?![A-Za-z0-9*])`, // 7 italic
  ].join('|'),
  'gi',
);

const TRAILING = /[.,;:!?]+$/;

function shortUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, '');
    const shown = `${u.hostname.replace(/^www\./, '')}${path}`;
    return shown.length > 42 ? `${shown.slice(0, 40)}…` : shown;
  } catch { return url; }
}

/**
 * A post's text with its references rendered inline. `entityRefs` lets the
 * caller suppress the chip for an id already shown elsewhere (unused today —
 * the inline chip is the ref's home).
 */
export default function PostText({ text, className = 'postcard-text', as: Tag = 'p' }) {
  if (!text) return null;
  const nodes = [];
  let last = 0;
  let key = 0;
  const re = new RegExp(TOKEN.source, TOKEN.flags);
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(<Fragment key={key++}>{text.slice(last, m.index)}</Fragment>);
    let consumedLen = m[0].length;
    if (m[1] != null) {
      nodes.push(<b key={key++}>{m[1]}</b>);
    } else if (m[2] != null) {
      nodes.push(<code key={key++}>{m[2]}</code>);
    } else if (m[7] != null) {
      nodes.push(<i key={key++}>{m[7]}</i>);
    } else if (m[3] != null) {
      nodes.push(<EntityChip key={key++} id={m[3]} compact className="postcard-ichip" />);
    } else if (m[4] != null) {
      const id = m[4].replace(/^arXiv:\s?/i, '');
      nodes.push(
        <a key={key++} className="postcard-inlink" href={`https://arxiv.org/abs/${id}`} target="_blank" rel="noopener noreferrer nofollow">
          {m[4]}
        </a>,
      );
    } else {
      // doi / url: trailing sentence punctuation belongs to the prose.
      const raw = m[5] != null ? m[5] : m[6];
      const clean = raw.replace(TRAILING, '');
      consumedLen -= raw.length - clean.length;
      const isDoi = m[5] != null;
      const href = isDoi ? `https://doi.org/${clean.replace(/^doi:\s?/i, '')}` : clean;
      nodes.push(
        <a key={key++} className="postcard-inlink" href={href} target="_blank" rel="noopener noreferrer nofollow">
          {isDoi ? clean : shortUrl(clean)}
        </a>,
      );
    }
    last = m.index + consumedLen;
    re.lastIndex = last;
  }
  if (last < text.length) nodes.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return <Tag className={className}>{nodes}</Tag>;
}
