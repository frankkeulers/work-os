import { firstMatchingRule, type Item, type LoggedDecision, type Me, type Rule, type Settings } from '@work-os/shared';

// Rules at ingest (FR-4.1–4.3, §5.3). The first enabled match decides what happens to a thread
// with new messages from someone other than Frank:
//   drop        a new thread is never stored (FR-2.10); one already stored is left alone
//   now, today  decided at once, without the model and without waiting for the quiet window
//   model       wait for the quiet window, then the model; `min` is a floor on its answer (M2 step 15)
//   file        the model too, for the summary and where to file it, then To file: attention None
//               and at least one filing destination suggested

export type RuleVerdict =
  | { kind: 'drop'; rule: Rule }
  | { kind: 'fixed'; rule: Rule; attention: 'now' | 'today' }
  | { kind: 'model'; rule?: Rule; min?: 'today' | 'now'; file?: true };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Who "me" is for the rules: the source's user ID, and "@name" in plain text once the name is known. */
export function meFrom(identity: { id: string; name?: string } | undefined): Me {
  const name = identity?.name?.trim();
  return { id: identity?.id ?? '', ...(name && { mentionRe: new RegExp(`@${escapeRe(name)}(?!\\w)`, 'i') }) };
}

export function ruleVerdict(item: Item, rules: Rule[], settings: Settings, me: Me): RuleVerdict {
  const rule = firstMatchingRule(item, rules, settings, me);
  if (!rule) return { kind: 'model' };
  const o = rule.outcome;
  if (o.type === 'drop') return { kind: 'drop', rule };
  if (o.type === 'now' || o.type === 'today') return { kind: 'fixed', rule, attention: o.type };
  if (o.type === 'file') return { kind: 'model', rule, file: true };
  return { kind: 'model', rule, ...(o.min && { min: o.min }) };
}

/** A rule's decision. Rules fix attention only, so they suggest no filing (FR-4.2). */
export function ruleDecision(item: Item, v: Extract<RuleVerdict, { kind: 'fixed' }>, at: Date): LoggedDecision {
  return {
    itemId: item.id,
    itemRevision: item.revision,
    attention: v.attention,
    confluence: { suggested: false },
    vault: { suggested: false },
    containsPeopleObservations: false,
    decidedBy: 'rule',
    ruleId: v.rule.id,
    decidedAt: at.toISOString(),
  };
}

export const ruleReason = (v: Extract<RuleVerdict, { kind: 'fixed' }>) =>
  `Rule “${v.rule.id}” sets ${v.attention === 'now' ? 'Now' : 'Today'} without asking the model.`;
