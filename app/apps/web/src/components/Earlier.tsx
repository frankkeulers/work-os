import { useEffect, useState, type ReactNode } from 'react';
import type { Item, Message, Participant } from '@work-os/shared';
import { api, type EarlierView } from '../api';
import { plural } from '../lib/format';
import { SOURCE_NAME } from '../lib/next';
import { Icon, type IconName } from './icons';

export type EarlierState = { state: 'loading' } | { state: 'ready'; view: EarlierView } | { state: 'failed' };

/** The week before a DM item, read from the source once `wanted` turns on, then kept for the item. */
export function useEarlier(item: Item, wanted: boolean): EarlierState | undefined {
  const [s, setS] = useState<{ id: string; v: EarlierState }>();
  const have = s?.id === item.id;
  useEffect(() => {
    if (!wanted || have) return;
    let live = true;
    api.getEarlier(item.id).then(
      (view) => live && setS({ id: item.id, v: { state: 'ready', view } }),
      () => live && setS({ id: item.id, v: { state: 'failed' } }),
    );
    return () => {
      live = false;
    };
  }, [item.id, wanted, have]);
  if (have) return s.v;
  return wanted ? { state: 'loading' } : undefined;
}

function EarlierButton({ icon, onClick, children }: { icon?: IconName; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="inline-flex min-h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium text-accent hover:bg-accent-wash cursor-pointer" onClick={onClick}>
      {icon && <Icon name={icon} size={13} />}
      {children}
    </button>
  );
}

/**
 * A DM's earlier conversation, hidden by default: then the last three messages, then the whole week
 * before the item, and hidden again. Returns the control row and the messages to show above the item.
 */
export function useEarlierToggle(item: Item): { controls: ReactNode; before: Message[]; people: Participant[] } {
  const [mode, setMode] = useState<'hidden' | 'recent' | 'all'>('hidden');
  const [forId, setForId] = useState(item.id);
  if (forId !== item.id) {
    setForId(item.id);
    setMode('hidden');
  }
  const can = item.kind === 'dm' && !item.contentExpired;
  const earlier = useEarlier(item, can && mode !== 'hidden');
  const all = mode !== 'hidden' && earlier?.state === 'ready' ? earlier.view.messages : [];
  const before = mode === 'all' ? all : all.slice(-3);
  const people = earlier?.state === 'ready' ? earlier.view.people : [];
  if (!can) return { controls: null, before, people };
  const controls = (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 py-1.5">
      {mode === 'hidden' ? (
        <EarlierButton icon="up" onClick={() => setMode('recent')}>
          Show earlier messages
        </EarlierButton>
      ) : (
        <>
          <span className="flex-1 font-mono text-[11px] text-muted">
            {earlier?.state === 'loading'
              ? 'Loading earlier messages…'
              : earlier?.state === 'failed'
                ? `Couldn’t load the earlier messages from ${SOURCE_NAME[item.source]}.`
                : all.length
                  ? mode === 'all'
                    ? `${plural(all.length, 'earlier message')} · the 7 days before`
                    : 'Earlier in the conversation'
                  : 'Nothing earlier in the 7 days before'}
          </span>
          {mode === 'recent' && all.length > before.length && <EarlierButton onClick={() => setMode('all')}>Show all {all.length} from the 7 days before</EarlierButton>}
          <EarlierButton icon="x" onClick={() => setMode('hidden')}>
            Hide
          </EarlierButton>
        </>
      )}
    </div>
  );
  return { controls, before, people };
}
