import { useEffect, useId, useState } from 'react';
import { api } from '../api';
import { channelKey, matchLookup, personKey, type LookupOption } from '../lib/lookup';
import { Icon } from './icons';
import { cx } from './ui';

/** One listing per page load, shared by every picker of a kind: the lists change rarely. */
function cached(load: () => Promise<LookupOption[]>): () => Promise<LookupOption[]> {
  let p: Promise<LookupOption[]> | undefined;
  return () =>
    (p ??= load().catch(() => {
      p = undefined; // try again next time a picker opens
      return [];
    }));
}

const loadChannels = cached(async () => (await api.getChannels()).map((value) => ({ value })));
const loadPeople = cached(async () => (await api.getPeople()).map((p) => ({ value: p.name, ...(p.realName && { detail: p.realName }) })));

/**
 * Values as chips, with a search over a list from the server. Type part of a name and pick it with
 * the arrow keys and Enter or a click. The list opens on typing or the down arrow, not on focus, so
 * it doesn't cover the fields below. A value not in the list can still be added with Enter or a comma.
 */
function LookupChips({
  label,
  values,
  onChange,
  load,
  keyOf,
  normalise = (v) => v,
  invalid,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  load: () => Promise<LookupOption[]>;
  /** How two values compare: "#Ops" and "ops" are the same channel. */
  keyOf: (s: string) => string;
  /** What a typed value is stored as. */
  normalise?: (typed: string) => string;
  invalid?: boolean;
  placeholder: string;
}) {
  const [all, setAll] = useState<LookupOption[]>([]);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  useEffect(() => {
    let live = true;
    void load().then((o) => live && setAll(o));
    return () => {
      live = false;
    };
  }, [load]);

  const matches = matchLookup(all, text, values, keyOf);
  const shown = open && matches.length > 0;
  const at = Math.min(active, matches.length - 1);

  const add = (raw: string) => {
    const v = raw.trim().replace(/,$/, '');
    if (!v) return;
    const value = normalise(v);
    if (!values.some((x) => keyOf(x) === keyOf(value))) onChange([...values, value]);
    setText('');
    setActive(0);
  };

  return (
    <div className="relative w-full">
      <div className={cx('flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-lg border bg-surface px-2 py-1.5 focus-within:border-accent', invalid ? 'border-red' : 'border-line-strong')}>
        {values.map((it) => (
          <span key={it} className="inline-flex items-center gap-0.5 rounded-md bg-track py-0.5 pl-2 pr-0.5 text-[13px] text-ink">
            {it}
            <button type="button" aria-label={`Remove ${it}`} className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-track-2 hover:text-ink cursor-pointer" onClick={() => onChange(values.filter((x) => x !== it))}>
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        <input
          role="combobox"
          aria-label={label}
          aria-invalid={invalid}
          aria-expanded={shown}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={shown ? `${listId}-${at}` : undefined}
          placeholder={values.length ? 'Add…' : placeholder}
          className="min-w-[120px] flex-1 border-0 bg-transparent px-1 text-[13px] font-normal text-ink outline-none"
          style={{ outline: 'none' }} // the field's border shows focus; the global focus ring would double it
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
            setOpen(e.target.value.trim() !== '');
          }}
          onBlur={() => {
            setOpen(false);
            add(text);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setOpen(true);
              if (matches.length) setActive((at + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
            } else if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
              // Tab picks the highlighted option only when there is something typed to complete.
              if (e.key === 'Tab' && !text.trim()) return;
              e.preventDefault();
              add(shown && e.key !== ',' ? matches[at].value : text);
            } else if (e.key === 'Escape' && shown) {
              e.preventDefault(); // the dialog leaves this Escape to the list
              setOpen(false);
            } else if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1));
          }}
        />
      </div>
      {shown && (
        <ul id={listId} role="listbox" aria-label={`${label} suggestions`} className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-auto rounded-lg border border-line bg-surface py-1 shadow-[0_8px_24px_rgba(20,23,28,0.18)]">
          {matches.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === at}
              className={cx('flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-[13px] font-normal text-ink', i === at && 'bg-accent-wash')}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault(); // keep focus in the input
                add(o.value);
              }}
            >
              {o.value}
              {o.detail && <span className="text-xs text-muted">{o.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type PickerProps = { label: string; values: string[]; onChange: (v: string[]) => void; invalid?: boolean; placeholder?: string };

const withHash = (v: string) => (v.startsWith('#') ? v : `#${v}`);

/** Channel names ("#name"), searched over the channels you're in, with or without the "#". */
export function ChannelPicker({ placeholder = 'Search channels…', ...p }: PickerProps) {
  return <LookupChips {...p} placeholder={placeholder} load={loadChannels} keyOf={channelKey} normalise={withHash} />;
}

/** People by the name the rules match on, searched by display or real name. */
export function PeoplePicker({ placeholder = 'Search people…', ...p }: PickerProps) {
  return <LookupChips {...p} placeholder={placeholder} load={loadPeople} keyOf={personKey} />;
}
