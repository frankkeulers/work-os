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

/** POST /api/items/:id/actions (FR-9.1, FR-10.2). */
export const DraftRequest = z.object({ type: z.enum(['vault_note', 'confluence_entry']) }).strict();

/** PUT /api/actions/:id/draft (FR-9.3): Frank's edited text. */
export const DraftEdit = z.object({ content: z.string().max(200_000) }).strict();
