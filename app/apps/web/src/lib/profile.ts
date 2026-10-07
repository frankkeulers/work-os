// The user's profile (Settings › Profile): names for the sidebar's account button and the avatar's
// initials. Like the picture, it's a client preference kept in this browser, not in settings.json.

export interface Profile {
  firstName?: string;
  lastName?: string;
  displayName?: string;
}

export const NAME_MAX = 60;

const clean = (s: string | undefined) => s?.trim().replace(/\s+/g, ' ') ?? '';
const firstLetter = (s: string) => (s ? Array.from(s)[0].toLocaleUpperCase() : '');

/** The name the app shows: the display name if set, else first and last name, else none. */
export function shownName(p: Profile): string | undefined {
  return clean(p.displayName) || [clean(p.firstName), clean(p.lastName)].filter(Boolean).join(' ') || undefined;
}

/** Up to two initials for the avatar: from first and last name, else from the display name's first and last words. */
export function initialsOf(p: Profile): string | undefined {
  let i = firstLetter(clean(p.firstName)) + firstLetter(clean(p.lastName));
  if (!i) {
    const words = clean(p.displayName).split(' ').filter(Boolean);
    i = firstLetter(words[0] ?? '') + (words.length > 1 ? firstLetter(words.at(-1)!) : '');
  }
  return i || undefined;
}
