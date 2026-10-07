import { Link } from 'react-router';
import { HELP, type HelpTopic } from '../guide/links';
import { Icon } from './icons';

/** A quiet link to the guide section that explains the thing next to it. */
export function GuideLink({ topic, label = 'Guide' }: { topic: HelpTopic; label?: string }) {
  return (
    <Link
      to={`/guide/${HELP[topic]}`}
      data-testid={`guide-link-${topic}`}
      className="inline-flex min-h-8 shrink-0 items-center gap-1.5 whitespace-nowrap text-[13px] font-medium !text-ink-2 no-underline hover:!text-ink"
    >
      <Icon name="book" size={14} />
      {label}
    </Link>
  );
}
