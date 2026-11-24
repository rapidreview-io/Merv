/** The words of a chat, as every chat draws them: the main thread's, a session's and Merv's own thread alike. */
import type { ComponentProps, ReactNode } from 'react';
import { Prose } from './prose';

/** An assistant's words, as Markdown, with whatever its chat adds under them. */
export function AssistantSaid({
  id,
  text,
  prose,
  children,
}: {
  id: string;
  text: string;
  prose?: Omit<ComponentProps<typeof Prose>, 'text'>;
  children?: ReactNode;
}) {
  const seq = id.slice(1);
  return (
    <div data-block-id={id} data-message-seq={seq} className="said assistant">
      <div className="assistant-text" data-message-seq={seq}>
        <Prose text={text} {...prose} />
      </div>
      {children}
    </div>
  );
}
