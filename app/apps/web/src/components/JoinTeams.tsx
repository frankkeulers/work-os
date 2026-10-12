import { useNow } from '../hooks/useNow';
import { meetingLink } from '../lib/links';
import { BrandIcon } from './BrandIcon';
import { cx } from './ui';

// Join in Teams (R2.8, Frank 12 Oct 2026): a Teams meeting's join link, opened in the browser rather
// than the Teams app, shown until the meeting ends. Solid where joining is the card's one action (the
// calendar's meeting card); secondary beside another primary, such as an invite's Respond in Outlook.

export function JoinTeams({ joinUrl, end, solid }: { joinUrl: string | undefined; end: string; solid?: boolean }) {
  const now = useNow(60_000);
  const go = meetingLink({ joinUrl, end }, now);
  if (!go.teams) return null;
  return (
    <a
      href={go.href}
      target="_blank"
      rel="noreferrer"
      data-join-teams
      className={cx(
        'inline-flex min-h-8 w-fit items-center gap-1.5 rounded-lg px-3 text-[13px] no-underline',
        solid ? 'bg-accent-bg font-semibold !text-on-solid hover:brightness-110' : 'border border-line-strong bg-surface font-medium !text-ink hover:bg-surface-2',
      )}
    >
      <BrandIcon brand="teams" size={16} decorative /> Join in Teams
    </a>
  );
}
