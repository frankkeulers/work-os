import { z } from 'zod';
import { ActionType, Attention, Ms365Connector } from './schemas';
import { TODO_MAX_LINES, TODO_MAX_STEP } from './todo';

// Request bodies for the API's commands. The server checks every body against these (FR-3.3);
// the settings themselves are checked field by field, so the UI can show each problem in place.

export const SettingsSave = z
  .object({
    settings: z.unknown(),
    rules: z.unknown(),
    // The files as the form had them when Frank made this change: only what he changed is applied
    // (mergeEdit). Without it the files are replaced whole.
    base: z.object({ settings: z.unknown(), rules: z.unknown() }).strict().optional(),
  })
  .strict();
export type SettingsSave = z.infer<typeof SettingsSave>;

/** POST /api/sources/outlook/connect (R2.5): the connector ID Frank entered, or none to find it. */
export const OutlookConnect = z.object({ connectorId: Ms365Connector.shape.id.optional() }).strict();
export type OutlookConnect = z.infer<typeof OutlookConnect>;

/** POST /api/items/:id/snooze (FR-8.2). The UI turns presets into an instant before sending. */
export const SnoozeInput = z.object({ until: z.iso.datetime() }).strict();
export type SnoozeInput = z.infer<typeof SnoozeInput>;

/** POST /api/items/done and /api/items/reopen: many items at once, e.g. a channel or Low priority. */
export const ItemIds = z.object({ ids: z.array(z.string().min(1)).min(1).max(1000) }).strict();

/** POST /api/items/:id/correction (FR-6.2): the triage Frank says it should have been. */
export const CorrectionBody = z.object({ attention: Attention, confluence: z.boolean(), vault: z.boolean() }).strict();

/** POST /api/items/:id/actions (FR-9.1, FR-10.2). */
// quiet: drafted ahead in a batch (FR-11.6). steps: for a to-do, the lines to start from (UX-5), else Frank's open steps.
// suggested: for a to-do, the one the filing policy suggested (FR-15.6), with its date.
export const DraftRequest = z
  .object({ type: ActionType, quiet: z.boolean().optional(), steps: z.array(z.string().trim().min(1).max(TODO_MAX_STEP)).min(1).max(TODO_MAX_LINES).optional(), suggested: z.literal(true).optional() })
  .strict()
  .refine((r) => !r.steps || r.type === 'todo', 'Only a to-do takes steps.')
  .refine((r) => !r.suggested || (r.type === 'todo' && !r.steps), 'Only a to-do can be the suggested one, and it takes no steps.');

/** POST /api/attention/dismiss (FR-11.5): an entry in the bell, by its key. */
export const AttentionDismiss = z.object({ key: z.string().min(1).max(300) }).strict();

/** POST /api/actions/:id/approve (FR-9.4); from a batch, the item is done once all its filings are written (cockpit CK-4.4). */
export const ApproveRequest = z.object({ markDoneWhenFiled: z.boolean().optional() }).strict();

/** PUT /api/prompts/:id (FR-1.7): the new text, and the version it was edited from. */
export const PromptSave = z.object({ text: z.string().max(200_000).refine((t) => t.trim().length > 0, 'The file can’t be empty'), baseVersion: z.string().min(1) }).strict();
export type PromptSave = z.infer<typeof PromptSave>;

/** POST /api/prompts/:id/reset (FR-1.7): back to the built-in default. */
export const PromptReset = z.object({ baseVersion: z.string().min(1) }).strict();
export type PromptReset = z.infer<typeof PromptReset>;

/** PUT /api/actions/:id/draft (FR-9.3): Frank's edited text; `part` picks one note of a draft that files into several (FR-9.7). */
export const DraftEdit = z.object({ content: z.string().max(200_000), part: z.number().int().nonnegative().optional() }).strict();
