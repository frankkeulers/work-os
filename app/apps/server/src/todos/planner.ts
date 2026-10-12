import { SLOT_BUFFER_MINUTES, todoSlots, type EventDraft, type Settings, type SlotResult, type TodoState } from '@work-os/shared';
import type { Logger } from '../log';
import type { CalendarSnapshot } from '../sources/calendar/store';
import type { Store } from '../store/store';

// When Frank will do each open To Do (E15, FR-16.8): code, not a model, finds it free time in his
// working hours around his meetings, before it is due (slots.ts). Nothing is booked: the slot is
// an event in Work OS and nowhere else. It runs on every tick, after each calendar poll and after
// a To Do changes, and logs only what moved, so an unchanged calendar is quiet. Frank's own slots
// (FR-16.9) are never moved. While Outlook Calendar is off, the slots the plan found are taken
// back; while it is on but not yet polled, nothing is touched.

export interface TodoPlannerDeps {
  store: Store;
  now: () => Date;
  config: () => { settings: Settings };
  /** Outlook Calendar is on, and its snapshot once polled. */
  calendar: () => { on: boolean; snapshot?: CalendarSnapshot };
  logger?: Logger;
}

export class TodoPlanner {
  private running?: Promise<number>;
  private again = false;

  constructor(private readonly d: TodoPlannerDeps) {}

  /** Every open To Do's slot, or why it has none: what the view shows. Undefined until the calendar is polled. */
  slots(): Record<string, SlotResult> | undefined {
    const cal = this.d.calendar();
    if (cal.on && !cal.snapshot) return undefined;
    const s = this.d.config().settings.schedule;
    const snap = cal.on ? cal.snapshot : undefined;
    return todoSlots(Object.values(this.d.store.projection.todos ?? {}), {
      now: this.d.now(),
      workHours: s.workHours,
      ...(snap && { events: snap.events, calendarTo: snap.to }),
      bufferMinutes: s.slotBufferMinutes ?? SLOT_BUFFER_MINUTES,
    });
  }

  /** Resolves to the events it logged. A call while a pass runs gets one more pass after it. */
  plan(): Promise<number> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run()
      .catch((err: unknown) => {
        this.d.logger?.warn({ err }, 'Planning To Dos failed; trying again on the next tick');
        return 0;
      })
      .finally(() => {
        this.running = undefined;
        if (this.again) {
          this.again = false;
          void this.plan();
        }
      });
    return this.running;
  }

  private async run(): Promise<number> {
    const slots = this.slots();
    if (!slots) return 0;
    const events: EventDraft[] = [];
    const ids = (t: TodoState) => ({ itemId: t.itemId, actionId: t.actionId });
    for (const t of Object.values(this.d.store.projection.todos ?? {})) {
      const r = slots[t.id];
      if (!r || t.status !== 'open' || t.slot?.by === 'you') continue;
      if (r.kind === 'slot' && (r.start !== t.slot?.start || r.end !== t.slot.end)) events.push({ type: 'todo.scheduled', ...ids(t), data: { todoId: t.id, start: r.start, end: r.end, by: 'plan' } });
      else if (r.kind === 'none' && t.slot) events.push({ type: 'todo.unscheduled', ...ids(t), data: { todoId: t.id, by: 'plan' } });
    }
    if (events.length) await this.d.store.append(...events);
    return events.length;
  }
}
