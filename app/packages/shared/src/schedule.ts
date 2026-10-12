import { z } from 'zod';

// A To Do's plan (E15, FR-16.6): how long the model thinks it will take, how sure it is, and when
// it would ideally be done. The model estimates; code holds the answer to what it may say. Shared
// by the server, the mock and the eval, so all three clamp alike.

/** At most this many To Dos in one call. */
export const SCHEDULE_MAX_PER_CALL = 20;
/** A To Do whose plan failed this often is left unplanned: it shows without an estimate. */
export const SCHEDULE_MAX_ATTEMPTS = 2;
/** An ideal deadline further off than this is dropped: too far to plan for. */
export const IDEAL_MAX_DAYS = 30;
/** Whys longer than this are cut. */
export const WHY_MAX = 160;

export const Confidence = z.enum(['low', 'medium', 'high']);
export type Confidence = z.infer<typeof Confidence>;

export const ScheduleTodoAnswer = z.object({
  id: z.string().min(1),
  effortMinutes: z.number().int().min(5).max(480),
  confidence: Confidence,
  /** When it would ideally be done. Absent: no better date than the deadline it has. */
  deadline: z.iso.datetime({ offset: true }).optional(),
  deadlineWhy: z.string().max(400).optional(),
  estimateWhy: z.string().max(400),
});
export type ScheduleTodoAnswer = z.infer<typeof ScheduleTodoAnswer>;

export const ScheduleAnswer = z.object({ todos: z.array(ScheduleTodoAnswer).max(SCHEDULE_MAX_PER_CALL) });
export type ScheduleAnswer = z.infer<typeof ScheduleAnswer>;

export interface Plan {
  effortMinutes: number;
  confidence: Confidence;
  /** The ideal deadline, when it is before the To Do's own and within IDEAL_MAX_DAYS. */
  ideal?: string;
  estimateWhy: string;
  deadlineWhy?: string;
}

const cut = (s: string) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > WHY_MAX ? `${t.slice(0, WHY_MAX - 1)}…` : t;
};

/**
 * The model's answer for one To Do, held to what it may say. A deadline the To Do already has
 * (triage's, the line's, or Frank's) is a hard ceiling: an ideal one at or after it is dropped, as
 * is one already past or more than IDEAL_MAX_DAYS off.
 */
export function clampPlan(a: ScheduleTodoAnswer, at: { now: Date; deadline?: string }): Plan {
  const ms = a.deadline ? Date.parse(a.deadline) : NaN;
  const ok = Number.isFinite(ms) && ms > at.now.getTime() && ms <= at.now.getTime() + IDEAL_MAX_DAYS * 86_400_000 && (!at.deadline || ms < Date.parse(at.deadline));
  const ideal = ok ? new Date(ms).toISOString() : undefined;
  return {
    effortMinutes: a.effortMinutes,
    confidence: a.confidence,
    ...(ideal && { ideal }),
    estimateWhy: cut(a.estimateWhy),
    ...(ideal && a.deadlineWhy && { deadlineWhy: cut(a.deadlineWhy) }),
  };
}
