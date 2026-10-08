// An email body as the text triage and the inbox read: only what this message adds. Outlook sends
// HTML with the whole conversation quoted under each reply, an external-sender banner on top, and
// signatures and legal disclaimers at the bottom; all of that is cut, links keep their address
// (Microsoft's safelinks unwrapped), and attachments become a line each. No HTML parser: the body is
// display text, never rendered, and a few patterns cover what Outlook, Gmail and Apple Mail send.

export const BODY_MAX_CHARS = 20_000;

/** Where the quoted conversation starts in an HTML body: the earliest marker found. */
const HTML_QUOTE_MARKERS = [
  /<div[^>]*\bid=["']?(?:x_)*appendonsend\b/i,
  /<div[^>]*\bid=["']?(?:x_)*divRplyFwdMsg\b/i,
  /<div[^>]*\bclass=["'][^"']*\bgmail_quote\b/i,
  /<blockquote[^>]*\btype=["']?cite\b/i,
  /<hr[^>]*>\s*(?:<[^>]+>\s*)*(?:<b>)?\s*From:/i,
  /-----\s*Original Message\s*-----/i,
];

/** The same in plain text, and in HTML once it is text (a quote without any of the markers above). */
const TEXT_QUOTE_MARKERS = [
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^_{10,}\s*\n\s*From: /m,
  /^From: .+\n(?:.*\n){0,2}?(?:Sent|Date): /m,
  /^On .{6,200}wrote:\s*$/m,
  /^Am .{6,200}schrieb .{1,100}:\s*$/m,
  /^Le .{6,200}a écrit\s*:\s*$/m,
];

/** A banner a mail gateway puts on top of external email. */
const BANNER_RE = /^\s*(?:\[?(?:external|caution|warning)\]?\s*[:!-]?\s*)?.{0,80}\b(?:e-?mail|message)\b.{0,40}\b(?:from|originated|came from)\b.{0,30}\b(?:an? )?(?:external|outside)\b/i;

/** Where the signature or the disclaimer starts. */
const TAIL_MARKERS = [
  /^-- ?$/m,
  /^(?:This (?:e-?mail|message|communication) and any (?:files|attachments)|CONFIDENTIALITY(?: NOTICE)?\b|Disclaimer:|DISCLAIMER\b|Get Outlook for |Sent from my (?:iPhone|iPad|Android|mobile))/m,
];

const NAMED: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—',
  hellip: '…', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', deg: '°', times: '×', zwnj: '', zwj: '', shy: '',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** A safelinks address as the address it wraps. */
export function unwrapUrl(url: string): string {
  try {
    const u = new URL(url);
    if (/(^|\.)safelinks\.protection\.outlook\.com$/i.test(u.hostname)) return u.searchParams.get('url') ?? url;
  } catch {
    // not a URL: leave it
  }
  return url;
}

const earliest = (text: string, res: RegExp[]) => Math.min(...res.map((re) => re.exec(text)?.index ?? Infinity));

/** HTML to plain text: blocks become lines, links keep their address, tags go. */
function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<img\b[^>]*>/gi, '');
  s = s.replace(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, _q, href: string, inner: string) => {
    const text = decodeEntities(inner.replace(/<[^>]+>/g, '')).trim();
    const url = unwrapUrl(decodeEntities(href).trim());
    if (/^mailto:/i.test(url)) return text || url.slice(7);
    if (!/^https?:/i.test(url)) return text;
    if (!text || text === url || text.replace(/\/$/, '') === url.replace(/\/$/, '')) return url;
    return `${text} (${url})`;
  });
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/li\s*>/gi, '')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)\s*>/gi, ' · ')
    .replace(/<\/?(p|div|h[1-6]|tr|ul|ol|li|table|tbody|thead|blockquote|section|article|header|footer|pre|hr)\b[^>]*>/gi, '\n')
    .replace(/<hr\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s);
}

/** Lines trimmed, runs of spaces and blank lines collapsed. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u2007\u202f\t]/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .split('\n')
    .map((l) =>
      l
        .replace(/ {2,}/g, ' ')
        .replace(/(?:\s*·\s*)+$/, '')
        .trim(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Without the gateway's external-sender banner, if one of the first paragraphs is one. */
function dropBanner(text: string): string {
  const paras = text.split(/\n\n/);
  const i = paras.slice(0, 3).findIndex((p) => BANNER_RE.test(p) && p.length < 400);
  return i < 0 ? text : [...paras.slice(0, i), ...paras.slice(i + 1)].join('\n\n').trim();
}

/** Cut at the first marker, unless that would leave nothing (a forward with no note of its own). */
function cutAt(text: string, res: RegExp[]): string {
  const at = earliest(text, res);
  return Number.isFinite(at) && text.slice(0, at).trim() ? text.slice(0, at) : text;
}

/**
 * The text an email adds: its body without the quoted conversation, the banner, the signature
 * and the disclaimer, then a line per attachment that isn't an inline image.
 */
export function emailText(body: { contentType?: string | null; content?: string | null } | null | undefined, attachments: { name?: string | null; isInline?: boolean | null }[] = []): string {
  const raw = body?.content ?? '';
  const isHtml = (body?.contentType ?? '').toLowerCase() === 'html' || /<(html|body|div|p|br)\b/i.test(raw);
  let text = raw;
  if (isHtml) {
    const at = earliest(raw, HTML_QUOTE_MARKERS);
    text = htmlToText(Number.isFinite(at) && htmlToText(raw.slice(0, at)).trim() ? raw.slice(0, at) : raw);
  }
  text = tidy(text);
  text = cutAt(text, TEXT_QUOTE_MARKERS);
  text = dropBanner(tidy(text));
  text = tidy(cutAt(text, TAIL_MARKERS));
  if (text.length > BODY_MAX_CHARS) text = `${text.slice(0, BODY_MAX_CHARS - 1)}…`;
  const files = attachments.filter((a) => !a.isInline && a.name?.trim()).map((a) => `📎 ${a.name!.trim()}`);
  return [text, files.join('\n')].filter(Boolean).join('\n\n');
}
