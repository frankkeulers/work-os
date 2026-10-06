import { z } from 'zod';

// Request bodies for the API's commands. The server checks every body against these (FR-3.3);
// the settings themselves are checked field by field, so the UI can show each problem in place.

export const SettingsSave = z.object({ settings: z.unknown(), rules: z.unknown() }).strict();
export type SettingsSave = z.infer<typeof SettingsSave>;

/** POST /api/items/:id/snooze (FR-8.2). The UI turns presets into an instant before sending. */
export const SnoozeInput = z.object({ until: z.iso.datetime() }).strict();
export type SnoozeInput = z.infer<typeof SnoozeInput>;

/** POST /api/items/:id/correction (FR-6.2): the triage Frank says it should have been. */
export const CorrectionBody = z.object({ attention: z.enum(['now', 'today', 'none']), confluence: z.boolean(), vault: z.boolean() }).strict();
