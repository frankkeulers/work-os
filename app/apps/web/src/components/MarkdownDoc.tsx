import { useEffect, useLayoutEffect, useRef } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { frontMatterFields, joinFrontMatter, splitFrontMatter, tidySerialised } from '../lib/markdown';
import { Icon, type IconName } from './icons';
import { cx } from './ui';

// A draft's markdown, rendered as rich text and, while editing, edited in place (Tiptap).
// Markdown stays the stored format: the editor reads it in and writes it back out. Front matter
// is shown as properties and edited in the Markdown view, where the raw text is always available.
// The view (rich text or Markdown) is chosen by the caller, so reading and editing share it.
// Loaded lazily, so the editor's code is only fetched when a draft is on screen.

export type DocMode = 'rich' | 'markdown';

const attrs = (editing: boolean, label: string): Record<string, string> =>
  editing ? { class: 'wos-prose', role: 'textbox', 'aria-multiline': 'true', 'aria-label': label } : { class: 'wos-prose', 'aria-label': `${label} preview` };

export default function MarkdownDoc({
  value,
  editing,
  onChange,
  label,
  mode = 'rich',
}: {
  value: string;
  editing: boolean;
  onChange?: (md: string) => void;
  label: string;
  mode?: DocMode;
}) {
  const { frontMatter, body } = splitFrontMatter(value);
  // What the editor last produced, so a value we emitted isn't loaded back into it.
  const emitted = useRef(value);
  const latest = useRef({ frontMatter, onChange });
  useEffect(() => {
    latest.current = { frontMatter, onChange };
  });

  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: false }, underline: false, trailingNode: false }), Markdown],
    content: body,
    contentType: 'markdown',
    editable: editing,
    // An editor that mounts already editing (a vault append, after its diff) focuses itself.
    autofocus: editing ? 'end' : false,
    editorProps: { attributes: attrs(editing, label) },
    onUpdate: ({ editor: e }) => {
      const md = joinFrontMatter(latest.current.frontMatter, tidySerialised(e.getMarkdown()));
      emitted.current = md;
      latest.current.onChange?.(md);
    },
  });

  // Where a click on the read-only text landed, so editing starts with the cursor there. Taken at
  // click time: the toolbar that appears when editing starts moves the text down.
  const clickedAt = useRef<number | null>(null);

  // A layout effect, so editing is set up in the same task as the click on Edit: keys typed
  // straight away land in a focused, editable editor.
  useLayoutEffect(() => {
    // Until its view is mounted the editor still has the options it was created with.
    if (!editor.isInitialized) return;
    editor.setOptions({ editorProps: { attributes: attrs(editing, label) } });
    editor.setEditable(editing, false);
    // Don't move a cursor that's already in the editor. In the Markdown view the textarea takes focus.
    if (editing && mode === 'rich' && !editor.isFocused) editor.commands.focus(clickedAt.current ?? 'end');
    clickedAt.current = null;
  }, [editor, editing, label, mode]);

  // Outside changes (a new draft, Cancel, typing in the Markdown view) replace the editor's content.
  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    editor.commands.setContent(splitFrontMatter(value).body, { contentType: 'markdown', emitUpdate: false });
  }, [editor, value]);

  const source = mode === 'markdown';
  return (
    <div className="flex flex-col gap-3">
      {editing && !source && <Toolbar editor={editor} />}
      {frontMatter && !source && <Properties frontMatter={frontMatter} />}
      {source && editing ? (
        <textarea
          aria-label={label}
          autoFocus
          className="min-h-[240px] w-full resize-y rounded-lg border border-line-strong bg-surface p-3 font-mono text-[13px] leading-relaxed text-ink outline-none focus:border-accent"
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
        />
      ) : source ? (
        <pre aria-label={`${label} preview`} className="m-0 whitespace-pre-wrap font-mono text-[13px] leading-relaxed text-ink-strong [overflow-wrap:anywhere]">
          {value}
        </pre>
      ) : (
        <EditorContent
          editor={editor}
          onClickCapture={(e) => {
            if (!editing) clickedAt.current = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos ?? null;
          }}
          className={cx(editing && 'cursor-text rounded-lg border border-line-strong bg-surface px-3.5 py-3 focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/15')}
        />
      )}
    </div>
  );
}

function Properties({ frontMatter }: { frontMatter: string }) {
  return (
    <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-lg bg-surface-2 px-3 py-2.5 font-mono text-[12px]" aria-label="Note properties">
      {frontMatterFields(frontMatter).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="m-0 min-w-0 break-words text-ink-2">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const TOOLS: { key: string; label: string; icon: IconName; run: (e: Editor) => void }[] = [
  { key: 'heading', label: 'Heading', icon: 'heading', run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { key: 'bold', label: 'Bold', icon: 'bold', run: (e) => e.chain().focus().toggleBold().run() },
  { key: 'italic', label: 'Italic', icon: 'italic', run: (e) => e.chain().focus().toggleItalic().run() },
  { key: 'code', label: 'Inline code', icon: 'code', run: (e) => e.chain().focus().toggleCode().run() },
  { key: 'bulletList', label: 'Bulleted list', icon: 'listBullet', run: (e) => e.chain().focus().toggleBulletList().run() },
  { key: 'orderedList', label: 'Numbered list', icon: 'listOrdered', run: (e) => e.chain().focus().toggleOrderedList().run() },
];

function Toolbar({ editor }: { editor: Editor }) {
  const active = useEditorState({ editor, selector: ({ editor: e }) => Object.fromEntries(TOOLS.map((t) => [t.key, e.isActive(t.key)])) });
  return (
    <div role="toolbar" aria-label="Formatting" data-no-shortcuts className="flex flex-wrap items-center gap-1 border-b border-line-soft pb-2.5">
      {TOOLS.map((t) => (
        <button
          key={t.key}
          type="button"
          aria-label={t.label}
          title={t.label}
          aria-pressed={!!active[t.key]}
          // Keep the selection in the editor while clicking.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => t.run(editor)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-2 cursor-pointer hover:bg-track aria-pressed:bg-accent-wash aria-pressed:text-accent"
        >
          <Icon name={t.icon} size={15} />
        </button>
      ))}
    </div>
  );
}
