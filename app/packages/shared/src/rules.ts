import type { Item, Rule, RuleCondition, Settings } from './schemas';

// Deterministic rules (FR-4.1, FR-4.2): first enabled match wins.

/** The signed-in user the rules are evaluated for. */
export interface Me {
  id: string; // Slack user id
  mentionRe?: RegExp; // plain-text mentions such as "@frank"; `<@id>` mentions always match
}

const listValues = (c: { list?: string; values: string[] }, s: Settings): string[] => {
  const named = c.list ? (s.slack[c.list as keyof Settings['slack']] as string[] | undefined) ?? [] : [];
  return [...named, ...c.values];
};

export const toRegExp = (pattern: string): RegExp => {
  const m = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  return m ? new RegExp(m[1], m[2]) : new RegExp(pattern, 'i');
};

function matches(c: RuleCondition, item: Item, s: Settings, me: Me): boolean {
  const others = item.messages.filter((m) => m.authorId !== me.id);
  switch (c.type) {
    case 'is_dm':
      return item.kind === 'dm';
    case 'mentions_me':
      return item.messages.some((m) => m.text.includes(`<@${me.id}>`) || (me.mentionRe?.test(m.text) ?? false));
    case 'sender_in': {
      const names = listValues(c, s).map((v) => v.toLowerCase());
      return others.some((m) => names.includes((item.participants.find((p) => p.id === m.authorId)?.name ?? '').toLowerCase()));
    }
    case 'channel_in':
      return listValues(c, s).some((ch) => ch.toLowerCase() === item.title.toLowerCase());
    case 'keyword': {
      try {
        const re = toRegExp(c.pattern);
        return item.messages.some((m) => re.test(m.text));
      } catch {
        return false;
      }
    }
  }
}

export function firstMatchingRule(item: Item, rules: Rule[], settings: Settings, me: Me): Rule | undefined {
  // Rules are written against Slack fields (FR-4.1); other sources go straight to the model.
  if (item.source !== 'slack') return undefined;
  return rules.find((r) => r.enabled && r.conditions.every((c) => matches(c, item, settings, me)));
}
