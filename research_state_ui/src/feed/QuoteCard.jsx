import Avatar from './Avatar';
import PostText from './PostText';
import { postTime } from './feedModel';

/**
 * A quoted post: the author's commentary sits above a compact copy of the
 * post it quotes — who said it, the first two lines, and its headline number
 * if it carried a stat. Missing quoted views (a post from beyond the loaded
 * project, or deleted rows) degrade to a quiet "quoting an earlier post".
 */
export default function QuoteCard({ quoted, now, inline = false }) {
  if (!quoted) return <p className="postcard-replyctx">quoting an earlier post</p>;
  const ts = quoted.created_at ? new Date(quoted.created_at).getTime() : null;
  return (
    <div className={`postcard-quote${inline ? ' postcard-quote--inline' : ''}`}>
      <div className="postcard-quote-by">
        {!inline && <Avatar handle={quoted.author_handle} role={quoted.author_role} />}
        <span className="postcard-quote-name">{quoted.author_handle}</span>
        {quoted.author_role && quoted.author_role !== 'main' && (
          <span className="postcard-role">{quoted.author_role}</span>
        )}
        {quoted.kind && <span className="postcard-kind">{quoted.kind}</span>}
        <span className="postcard-time">{postTime(ts, now)}</span>
      </div>
      <PostText text={quoted.text} className="postcard-quote-text" />
      {quoted.stat && (
        <div className="postcard-quote-stat">
          <b>{quoted.stat.value}</b>
          {quoted.stat.unit && ` ${quoted.stat.unit}`}
          {quoted.stat.delta && ` · ${quoted.stat.delta}`}
        </div>
      )}
      {quoted.has_image && <div className="postcard-quote-media">image</div>}
    </div>
  );
}
