import { z } from 'zod';

// Request bodies for the API's commands. The server checks every body against these (FR-3.3);
// the settings themselves are checked field by field, so the UI can show each problem in place.

export const SettingsSave = z.object({ settings: z.unknown(), rules: z.unknown() }).strict();
export type SettingsSave = z.infer<typeof SettingsSave>;

/** POST /api/items/:id/snooze (FR-8.2). The UI turns presets into an instant before sending. */
export const SnoozeInput = z.object({ until: z.iso.datetime() }).strict();
export type SnoozeInput = z.infer<typeof SnoozeInput>;
