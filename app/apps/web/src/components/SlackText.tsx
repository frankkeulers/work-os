import { Fragment, type ReactNode } from 'react';
import type { Item, Participant } from '@work-os/shared';
import { parseMrkdwn, type Inline } from '../lib/mrkdwn';
import { cx } from './ui';

/** A Slack message's mrkdwn as formatted text. `name` gives a mentioned user's display name. */
export function SlackText({ text, meId, name, className }: { text: string; meId?: string; name: (id: string) => string | undefined; className?: string }) {
  const inline = (nodes: Inline[]): ReactNode[] =>
    nodes.map((n, i) => {
      switch (n.t) {
        case 'text':
          return <Fragment key={i}>{n.text}</Fragment>;
        case 'b':
          return <strong key={i} className="font-semibold">{inline(n.children)}</strong>;
        case 'i':
          return <em key={i}>{inline(n.children)}</em>;
        case 's':
          return <s key={i}>{inline(n.children)}</s>;
        case 'code':
          return (
            <code key={i} className="rounded border border-line-soft bg-surface-2 px-1 font-mono text-[12px]">
              {n.text}
            </code>
          );
        case 'link':
          return (
            <a key={i} href={n.href} target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">
              {n.text}
            </a>
          );
        case 'user':
          return (
            <span key={i} className={cx('rounded px-0.5 text-accent-ink', n.id === meId ? 'bg-accent-wash font-semibold' : 'bg-surface-2')}>
              @{name(n.id) ?? n.label ?? 'someone'}
            </span>
          );
        case 'tag':
          return (
            <span key={i} className="rounded bg-surface-2 px-0.5 text-accent-ink">
              {n.text}
            </span>
          );
      }
    });
  const lines = (ls: Inline[][]) =>
    ls.map((l, i) => (
      <Fragment key={i}>
        {i > 0 && <br />}
        {inline(l)}
      </Fragment>
    ));
  return (
    <div className={cx('flex flex-col gap-1.5 [overflow-wrap:anywhere]', className)}>
      {parseMrkdwn(text).map((b, i) =>
        b.t === 'pre' ? (
          <pre key={i} className="m-0 overflow-x-auto whitespace-pre rounded-md border border-line-soft bg-surface-2 px-2.5 py-2 font-mono text-[12px]">
            {b.text}
          </pre>
        ) : b.t === 'quote' ? (
          <blockquote key={i} className="m-0 border-l-[3px] border-line pl-2.5 text-ink-2">
            {lines(b.lines)}
          </blockquote>
        ) : (
          <p key={i} className="m-0">
            {lines(b.lines)}
          </p>
        ),
      )}
    </div>
  );
}

/** A message's text: Slack's formatted, other sources' as written, line breaks kept (a meeting summary). */
/** Wispr Flow's summary is Markdown: its "### Next Steps" headings show as headings, the rest as written. */
function NotesText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cx('whitespace-pre-wrap', className)}>
      {text.split('\n').map((line, i) => {
        const h = /^#{1,6}\s+(.*)$/.exec(line);
        return h ? (
          <div key={i} className="mt-2 font-semibold text-ink first:mt-0">
            {h[1]}
          </div>
        ) : (
          <div key={i}>{line || '\u00a0'}</div>
        );
      })}
    </div>
  );
}

export function MessageText({ item, meId, text, people = [], className }: { item: Item; meId?: string; text: string; people?: Participant[]; className?: string }) {
  if (item.source === 'wispr') return <NotesText text={text} className={className} />;
  if (item.source !== 'slack') return <div className={cx('whitespace-pre-wrap', className)}>{text}</div>;
  const name = (id: string) => [...item.participants, ...(item.mentioned ?? []), ...people].find((p) => p.id === id)?.name ?? (id === meId ? 'you' : undefined);
  return <SlackText text={text} meId={meId} name={name} className={className} />;
}
