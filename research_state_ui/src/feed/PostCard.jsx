import { useCallback, useEffect, useRef, useState } from 'react';
import { feedApi } from './feedApi';
import { useAuthedImage } from './useAuthedImage';
import { postTime, isOpenQuestion } from './feedModel';
import Attachments from './Attachments';
import Avatar from './Avatar';
import EmbedCard from './EmbedCard';
import Lightbox from './Lightbox';
import LinkCard from './LinkCard';
import PdfPageCard, { pdfPageInfo } from './PdfPageCard';
import PostText from './PostText';
import QuoteCard from './QuoteCard';
import ReplyComposer from './ReplyComposer';
import EntityChip from '../components/EntityChip';

// Reaction glyphs — solid geometric "instrument marks", not pictograms:
// boost (rounded triangle, "raise this"), watching (fisheye ring + dot),
// ask (typographic question mark). Single currentColor fills so every
// rest/hover/active state is pure CSS color. Kind keys stay fire/eyes/
// question — they are the API contract; only the artwork is abstract.
const GLYPH_VIEWBOX = '0 0 24 24';
const GLYPH_SHAPES = {
  fire: (
    <path
      fill="currentColor"
      d="M12 3.9 6.4 10.1c-.55.6-.12 1.55.68 1.55h3.28v6.8a1.64 1.64 0 0 0 3.28 0v-6.8h3.28c.8 0 1.23-.95.68-1.55L12 3.9Z"
    />
  ),
  eyes: (
    <path
      fill="currentColor" fillRule="evenodd" clipRule="evenodd"
      d="M12 5.6C7.4 5.6 3.6 8.9 2.1 12c1.5 3.1 5.3 6.4 9.9 6.4s8.4-3.3 9.9-6.4c-1.5-3.1-5.3-6.4-9.9-6.4Zm0 9.7a3.3 3.3 0 1 1 0-6.6 3.3 3.3 0 1 1 0 6.6Z"
    />
  ),
  question: (
    <path
      fill="currentColor"
      d="M11.95 4.7c-2.7 0-4.55 1.6-4.8 4.05l2.8.4c.15-1.25.85-1.9 2-1.9 1.1 0 1.8.65 1.8 1.65 0 .85-.45 1.4-1.55 2.2-1.3.95-1.85 1.85-1.85 3.35v.75h2.8v-.45c0-.95.45-1.45 1.6-2.3 1.3-.95 2.05-2 2.05-3.55 0-2.55-1.95-4.2-4.85-4.2ZM11.75 19.55a1.85 1.85 0 1 0 0-3.7 1.85 1.85 0 1 0 0 3.7Z"
    />
  ),
};

function ReactGlyph({ kind }) {
  return (
    <svg viewBox={GLYPH_VIEWBOX} width="15" height="15" aria-hidden="true">
      {GLYPH_SHAPES[kind]}
    </svg>
  );
}

const REACT_KINDS = ['fire', 'eyes', 'question'];
const REACT_LABEL = { fire: 'More like this', eyes: 'Watching this', question: 'Explain this' };

/**
 * The media a post carries besides its native attachments: one uploaded image
 * (natural ratio, framed, lightbox on click), one embed, and one link (paper /
 * repo / page card, or an inline PDF page).
 */
function Media({ post, projectId }) {
  const preview = post.link_preview;
  const pdfInfo = pdfPageInfo(post, preview);
  const image = useAuthedImage(post.image_url);
  const linkThumb = useAuthedImage(preview && preview.has_image ? preview.image_url : null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const mediaBtnRef = useRef(null);

  const openZoom = () => {
    setZoomed(true);
    feedApi.trackFeed(projectId, 'image_viewed', { post_id: post.id }).catch(() => {});
  };
  const closeZoom = useCallback(() => {
    setZoomed(false);
    mediaBtnRef.current?.focus();
  }, []);

  return (
    <>
      <Attachments items={post.attachments} />
      {post.image_url && !image.failed && (
        <div className={`postcard-media${imageLoaded ? ' is-loaded' : ''}`}>
          <button
            ref={mediaBtnRef}
            type="button"
            className="postcard-media-btn"
            onClick={openZoom}
            disabled={!image.url}
            aria-label="View image full size"
          >
            {image.url && (
              <img
                src={image.url}
                alt=""
                className={`postcard-image${imageLoaded ? ' is-loaded' : ''}`}
                onLoad={() => setImageLoaded(true)}
              />
            )}
          </button>
        </div>
      )}
      {zoomed && image.url && <Lightbox src={image.url} onClose={closeZoom} />}
      {post.has_embed && post.embed_url && <EmbedCard post={post} projectId={projectId} />}
      {post.link_url && (
        pdfInfo
          ? <PdfPageCard post={post} projectId={projectId} info={pdfInfo} />
          : <LinkCard post={post} preview={preview} thumbUrl={linkThumb.url} projectId={projectId} />
      )}
    </>
  );
}

// The byline: mark · name (bio on hover) · role · kind · time. `askYou` marks
// an unanswered question — the one accent in a byline, because it is an
// action for the researcher rather than decoration.
function Byline({ post, now, askYou, threadLen, withMark = true }) {
  const ts = post.created_at ? new Date(post.created_at).getTime() : null;
  const timeLabel = postTime(ts, now);
  const researcher = post.author_role === 'researcher';
  return (
    <header className="postcard-head">
      {withMark && <Avatar handle={post.author_handle} role={post.author_role} />}
      <span
        className={`postcard-author${researcher ? ' postcard-author--human' : ''}`}
        title={post.author_bio || undefined}
      >
        {post.author_handle}
      </span>
      {post.author_role && post.author_role !== 'main' && !researcher && (
        <span className="postcard-role">{post.author_role}</span>
      )}
      {post.kind && <span className="postcard-kind">{post.kind}</span>}
      {threadLen > 0 && <span className="postcard-kind">thread</span>}
      {askYou && <span className="postcard-asks">asks you</span>}
      {timeLabel && (
        <span
          className="postcard-time"
          title={Number.isFinite(ts) ? new Date(ts).toLocaleString() : undefined}
        >
          {timeLabel}
        </span>
      )}
    </header>
  );
}

function ReplyBlock({ card, projectId, now }) {
  const { post } = card;
  const researcher = post.author_role === 'researcher';
  return (
    <div className={`postcard-reply${researcher ? ' postcard-reply--human' : ''}`}>
      <Byline post={post} now={now} />
      <PostText text={post.text} />
      <Media post={post} projectId={projectId} />
    </div>
  );
}

/**
 * One feed card: a root post with its own thread continuations (one chain,
 * one connector), its media, its quoted post, and its replies. Deliberately
 * one shape for every post — nothing in the chrome encodes the kind; the kind
 * is a word in the byline and the content carries the rest.
 */
export default function PostCard({
  card,
  projectId,
  onView,
  now,
  onReact,
  onReply,
}) {
  const { post, chain, replies, orphan } = card;
  const cardRef = useRef(null);
  const viewedRef = useRef(false);
  const [composing, setComposing] = useState(false);
  const [showReplies, setShowReplies] = useState(false);

  // Fire post_viewed once, when the card first enters the viewport.
  useEffect(() => {
    if (!onView || !cardRef.current || viewedRef.current) return undefined;
    const el = cardRef.current;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && !viewedRef.current) {
          viewedRef.current = true;
          onView(post.id);
          io.disconnect();
        }
      }
    }, { threshold: 0.5 });
    io.observe(el);
    return () => io.disconnect();
  }, [post.id, onView]);

  const researcher = post.author_role === 'researcher';
  const reactions = post.reactions || {};
  const anyOn = REACT_KINDS.some((k) => reactions[k]);
  const askYou = isOpenQuestion(card);
  const humanReplies = replies.filter((r) => r.post.author_role === 'researcher');
  const agentReplies = replies.filter((r) => r.post.author_role !== 'researcher');
  const showRefChip = Boolean(post.ref) && !(post.text || '').includes(post.ref);

  const cls = [
    'postcard',
    researcher ? 'postcard--researcher' : '',
    chain.length ? 'postcard--thread' : '',
  ].filter(Boolean).join(' ');

  const actions = (onReact || onReply) && (
    <div className={`postcard-actions${anyOn ? ' has-on' : ''}`}>
      {onReact && REACT_KINDS.map((k) => (
        <button
          key={k}
          type="button"
          className={`postcard-react${reactions[k] ? ' on' : ''}`}
          aria-pressed={Boolean(reactions[k])}
          aria-label={REACT_LABEL[k]}
          data-tip={REACT_LABEL[k]}
          onClick={() => onReact(post, k)}
        >
          <ReactGlyph kind={k} />
        </button>
      ))}
      {onReply && !composing && (
        <button
          type="button"
          className="postcard-replybtn"
          data-tip="Reply"
          onClick={() => setComposing(true)}
        >
          Reply
        </button>
      )}
    </div>
  );

  const body = (
    <>
      <PostText text={post.text} />
      {post.quote_of && <QuoteCard quoted={post.quoted} now={now} />}
      <Media post={post} projectId={projectId} />
    </>
  );

  return (
    <article className={cls} ref={cardRef}>
      {orphan && (
        <p className="postcard-replyctx">
          {post.thread_root ? 'continuing an earlier thread' : 'replying to an earlier post'}
        </p>
      )}

      {chain.length === 0 ? (
        <>
          <Byline post={post} now={now} askYou={askYou} threadLen={0} />
          {body}
        </>
      ) : (
        <div className="postcard-chain">
          <div className="postcard-tp">
            <div className="postcard-rail"><Avatar handle={post.author_handle} role={post.author_role} /></div>
            <div className="postcard-tp-body">
              <Byline post={post} now={now} askYou={askYou} threadLen={chain.length} withMark={false} />
              {body}
            </div>
          </div>
          {chain.map((item, index) => {
            const ts = item.created_at ? new Date(item.created_at).getTime() : null;
            const prev = index === 0 ? post : chain[index - 1];
            const prevTs = prev.created_at ? new Date(prev.created_at).getTime() : null;
            const label = postTime(ts, now);
            // A continuation posted in the same breath as the one above needs
            // no timestamp; one added hours later says when.
            const showTime = label && label !== postTime(prevTs, now);
            return (
              <div className="postcard-tp" key={item.id}>
                <div className="postcard-rail"><Avatar handle={item.author_handle} role={item.author_role} /></div>
                <div className={`postcard-tp-body${showTime ? '' : ' postcard-tp-body--tight'}`}>
                  {showTime && (
                    <span className="postcard-tp-time" title={Number.isFinite(ts) ? new Date(ts).toLocaleString() : undefined}>
                      {label}
                    </span>
                  )}
                  <PostText text={item.text} />
                  {item.quote_of && <QuoteCard quoted={item.quoted} now={now} />}
                  <Media post={item} projectId={projectId} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {humanReplies.map((r) => <ReplyBlock key={r.id} card={r} projectId={projectId} now={now} />)}
      {agentReplies.length > 0 && !showReplies && (
        <button type="button" className="postcard-replies" onClick={() => setShowReplies(true)}>
          <span className="postcard-replies-marks">
            {[...new Set(agentReplies.map((r) => r.post.author_handle))].slice(0, 3).map((h) => (
              <Avatar key={h} handle={h} role={agentReplies.find((r) => r.post.author_handle === h)?.post.author_role} />
            ))}
          </span>
          {agentReplies.length} {agentReplies.length === 1 ? 'reply' : 'replies'}
          {' · '}
          {[...new Set(agentReplies.map((r) => r.post.author_handle))].slice(0, 3).join(', ')}
        </button>
      )}
      {showReplies && agentReplies.map((r) => <ReplyBlock key={r.id} card={r} projectId={projectId} now={now} />)}

      {(showRefChip || actions) && (
        <footer className="postcard-foot">
          {showRefChip && <EntityChip id={post.ref} className="postcard-ref-chip" />}
          {actions}
        </footer>
      )}

      {composing && (
        <ReplyComposer
          onSubmit={(text) => onReply(post, text)}
          onClose={() => setComposing(false)}
        />
      )}
    </article>
  );
}
