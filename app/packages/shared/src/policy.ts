import { effectiveTriage, type DecisionLike } from './lanes';
import { POLICY_RULE_RE, type FilingSettings, type FilingSuggestion, type TodoSuggestion, type TriageCorrection } from './schemas';

// The filing policy's say on an item (E14, FR-15.2–15.6), with Frank's switches in Settings ›
// Learning applied. The server and the mock build the inbox rows from these.

export type FilingType = 'confluence_entry' | 'vault_note';

export interface FilingPlan {
  /** Draft it ahead (FR-15.3). */
  predraft: boolean;
  /** Offer it in Ready to approve (FR-15.5). Always predraft too. */
  ready: boolean;
  /** The policy rule that applied, such as "R1". */
  rule?: string;
}

export type FilingPlans = Partial<Record<FilingType, FilingPlan>>;

const FIELD: Record<FilingType, 'confluence' | 'vault'> = { confluence_entry: 'confluence', vault_note: 'vault' };

/** A rule ID as the policy writes them, or nothing. */
export const policyRule = (rule: string | undefined) => (rule && POLICY_RULE_RE.test(rule) ? rule : undefined);

/**
 * The plan for each suggested filing. A decision from before the policy (no `predraft`) pre-drafts
 * every suggested filing, as drafts ahead did then. A filing Frank turned on with a correction is
 * pre-drafted but not ready, unless the decision suggested it too.
 */
export function filingPlan(decision: DecisionLike | undefined, correction: TriageCorrection | undefined, settings: FilingSettings): FilingPlans {
  const eff = effectiveTriage(decision, correction);
  const out: FilingPlans = {};
  if (!eff) return out;
  for (const type of ['confluence_entry', 'vault_note'] as const) {
    const field = FIELD[type];
    if (!eff[field]) continue;
    const f: FilingSuggestion | undefined = decision?.[field].suggested ? decision[field] : undefined;
    const policyPredraft = f ? (f.predraft ?? true) : true;
    const predraft = settings.predraft === 'all' ? true : settings.predraft === 'off' ? false : policyPredraft;
    const ready = predraft && settings.ready && !!f?.ready;
    const rule = policyRule(f?.rule);
    out[type] = { predraft, ready, ...(rule && { rule }) };
  }
  return out;
}

/** The to-do the panel offers (FR-15.6): while the switch is on, and until one is added or the suggestion dismissed. */
export function todoOffer(
  todo: TodoSuggestion | undefined,
  o: { settings: FilingSettings; revision: number; dismissed?: number; hasTodo: boolean; open: boolean },
): TodoSuggestion | undefined {
  if (!todo || !o.settings.todoSuggestions || !o.open || o.hasTodo) return undefined;
  if (o.dismissed !== undefined && o.dismissed >= o.revision) return undefined;
  return todo;
}
