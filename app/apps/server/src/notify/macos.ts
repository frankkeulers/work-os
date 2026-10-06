import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';

// macOS notifications (FR-11.1). terminal-notifier when it is installed, because a click on its
// notification can open the item; otherwise osascript, which can only show text. Text always goes
// in as arguments, never spliced into a script or a shell command.

export interface Notification {
  title: string;
  message: string;
  /** Opened when the notification is clicked (terminal-notifier only). */
  url?: string;
  /** A newer notification with the same group replaces the older one. */
  group?: string;
}

export interface Notifier {
  notify(n: Notification): Promise<void>;
  /** Which tool shows the notifications, for the log. */
  readonly kind?: 'terminal-notifier' | 'osascript' | 'silent';
}

/** Text goes in as arguments, never spliced into the script, so nothing in it can run as AppleScript. */
const SCRIPT = ['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv)', 'end run'];

export function osascriptNotifier(prefix = ''): Notifier {
  return {
    kind: 'osascript',
    notify: (n) =>
      new Promise((resolve) => {
        const args = SCRIPT.flatMap((line) => ['-e', line]);
        // A failed notification is never fatal: the same problem is in the log and the UI.
        execFile('/usr/bin/osascript', [...args, `${prefix}${n.title}`, n.message], { timeout: 5000 }, () => resolve());
      }),
  };
}

/** terminal-notifier reads a value that starts with "-" or "[" as something else; a backslash escapes it. */
const safe = (s: string) => (/^[-[\\]/.test(s) ? `\\${s}` : s);

export function terminalNotifierArgs(n: Notification, prefix = ''): string[] {
  return ['-title', safe(`${prefix}${n.title}`), '-message', safe(n.message), ...(n.url ? ['-open', n.url] : []), ...(n.group ? ['-group', n.group] : [])];
}

export function terminalNotifier(bin: string, prefix = ''): Notifier {
  return {
    kind: 'terminal-notifier',
    notify: (n) =>
      new Promise((resolve) => {
        execFile(bin, terminalNotifierArgs(n, prefix), { timeout: 5000 }, () => resolve());
      }),
  };
}

/** Homebrew's places; launchd's PATH doesn't include them, so they are checked directly. */
export const TERMINAL_NOTIFIER_PATHS = ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier'];

export async function systemNotifier(prefix = '', paths = TERMINAL_NOTIFIER_PATHS): Promise<Notifier> {
  for (const p of paths) {
    try {
      await access(p, constants.X_OK);
      return terminalNotifier(p, prefix);
    } catch {
      // not here
    }
  }
  return osascriptNotifier(prefix);
}

export const silentNotifier: Notifier = { kind: 'silent', notify: async () => undefined };
