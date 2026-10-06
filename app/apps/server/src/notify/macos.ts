import { execFile } from 'node:child_process';

// macOS notifications. This is the fallback with no dependencies, used for startup problems;
// click-to-open notifications through terminal-notifier come in M3 (FR-11.1).

export interface Notification {
  title: string;
  message: string;
}

export interface Notifier {
  notify(n: Notification): Promise<void>;
}

/** Text goes in as arguments, never spliced into the script, so nothing in it can run as AppleScript. */
const SCRIPT = ['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv)', 'end run'];

export function osascriptNotifier(prefix = ''): Notifier {
  return {
    notify: (n) =>
      new Promise((resolve) => {
        const args = SCRIPT.flatMap((line) => ['-e', line]);
        // A failed notification is never fatal: the same problem is in the log and the UI.
        execFile('/usr/bin/osascript', [...args, `${prefix}${n.title}`, n.message], { timeout: 5000 }, () => resolve());
      }),
  };
}

export const silentNotifier: Notifier = { notify: async () => undefined };
