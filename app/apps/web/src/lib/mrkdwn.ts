// Slack message text is "mrkdwn": *bold*, _italic_, ~strike~, `code`, ```pre```, "> " quotes,
// <@U123> mentions, <url|label> links and :emoji: shortcodes, with &, < and > escaped as entities.
// This parses it into a small tree the panel renders; anything it doesn't recognise stays as text.

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'b' | 'i' | 's'; children: Inline[] }
  | { t: 'code'; text: string }
  | { t: 'link'; href: string; text: string }
  | { t: 'user'; id: string; label?: string }
  | { t: 'tag'; text: string }; // #channel, @here, @team

export type Block = { t: 'p'; lines: Inline[][] } | { t: 'quote'; lines: Inline[][] } | { t: 'pre'; text: string };

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const SAFE_HREF = /^(https?:|mailto:)/i;

const EMOJI: Record<string, string> = {
  white_check_mark: '✅', heavy_check_mark: '✔️', ballot_box_with_check: '☑️', x: '❌', warning: '⚠️', information_source: 'ℹ️',
  question: '❓', exclamation: '❗', bangbang: '‼️', no_entry: '⛔', rotating_light: '🚨', red_circle: '🔴', large_green_circle: '🟢',
  large_yellow_circle: '🟡', large_blue_circle: '🔵', '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎', ok_hand: '👌',
  clap: '👏', raised_hands: '🙌', pray: '🙏', muscle: '💪', wave: '👋', point_right: '👉', point_left: '👈', point_up: '☝️',
  point_down: '👇', eyes: '👀', tada: '🎉', rocket: '🚀', fire: '🔥', sparkles: '✨', bulb: '💡', memo: '📝', pushpin: '📌',
  calendar: '📅', date: '📅', hourglass: '⌛', hourglass_flowing_sand: '⏳', lock: '🔒', link: '🔗', '100': '💯', heart: '❤️',
  smile: '😄', smiley: '😃', grin: '😁', grinning: '😀', joy: '😂', sweat_smile: '😅', wink: '😉', blush: '😊',
  slightly_smiling_face: '🙂', upside_down_face: '🙃', thinking_face: '🤔', face_palm: '🤦', facepalm: '🤦', shrug: '🤷',
  sob: '😭', cry: '😢', disappointed: '😞', scream: '😱', sunglasses: '😎', see_no_evil: '🙈', arrow_right: '➡️',
  arrow_left: '⬅️', arrow_up: '⬆️', arrow_down: '⬇️', heavy_plus_sign: '➕', heavy_minus_sign: '➖', star: '⭐', zap: '⚡',
  chart_with_upwards_trend: '📈', bar_chart: '📊', gear: '⚙️', hammer_and_wrench: '🛠️', mag: '🔍', email: '📧', ship: '🚢',
};

/** One <…> control sequence, given its inside. */
function angle(inner: string): Inline {
  const bar = inner.indexOf('|');
  const head = bar < 0 ? inner : inner.slice(0, bar);
  const label = bar < 0 ? undefined : decode(inner.slice(bar + 1));
  if (head.startsWith('@')) return { t: 'user', id: head.slice(1), label };
  if (head.startsWith('#')) return { t: 'tag', text: `#${label ?? 'channel'}` };
  if (head.startsWith('!')) {
    const [kind] = head.slice(1).split('^');
    if (kind === 'here' || kind === 'channel' || kind === 'everyone') return { t: 'tag', text: `@${kind}` };
    if (kind === 'subteam') return { t: 'tag', text: label ?? '@team' };
    return { t: 'text', text: label ?? '' }; // <!date^…|fallback>
  }
  const href = decode(head);
  if (!SAFE_HREF.test(href)) return { t: 'text', text: label ?? href };
  return { t: 'link', href, text: label ?? href.replace(/^mailto:/i, '') };
}

// Formatting opens after a non-word character and closes before one, as in Slack.
const INLINE = /<([^<>\n]+)>|`([^`\n]+)`|(?<![\p{L}\p{N}])([*_~])(?=\S)([^\n]*?\S)\3(?![\p{L}\p{N}])|:([a-z0-9_+-]+):(?::skin-tone-\d:)?/gu;
const MARK = { '*': 'b', _: 'i', '~': 's' } as const;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const text = (s: string) => {
    if (!s) return;
    const last = out.at(-1);
    if (last?.t === 'text') last.text += decode(s);
    else out.push({ t: 'text', text: decode(s) });
  };
  let at = 0;
  for (const m of src.matchAll(INLINE)) {
    text(src.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] !== undefined) {
      const node = angle(m[1]);
      if (node.t === 'text') text(node.text);
      else out.push(node);
    } else if (m[2] !== undefined) out.push({ t: 'code', text: decode(m[2]) });
    else if (m[3] !== undefined) out.push({ t: MARK[m[3] as keyof typeof MARK], children: parseInline(m[4]) });
    else text(EMOJI[m[5]] ?? m[0]);
  }
  text(src.slice(at));
  return out;
}

const QUOTE = /^(?:&gt;|>) ?/;

export function parseMrkdwn(src: string): Block[] {
  const blocks: Block[] = [];
  // ``` fences first: their content is literal.
  const parts = src.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1 && i < parts.length - 1) {
      blocks.push({ t: 'pre', text: decode(part.replace(/^\n|\n$/g, '')) });
      return;
    }
    const chunk = i % 2 === 1 ? '```' + part : part; // an unclosed fence is text
    for (const line of chunk.replace(/^\n|\n$/g, '').split('\n')) {
      const quoted = QUOTE.test(line);
      const kind = quoted ? 'quote' : 'p';
      const parsed = parseInline(quoted ? line.replace(QUOTE, '') : line);
      const last = blocks.at(-1);
      if (last && last.t === kind) last.lines.push(parsed);
      else blocks.push({ t: kind, lines: [parsed] });
    }
  });
  return blocks.filter((b) => b.t === 'pre' || b.lines.some((l) => l.length));
}
