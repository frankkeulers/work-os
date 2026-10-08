import { ruleSources, type Item, type NamedList, type Rule, type RuleCondition, type Settings, type SourceId } from './schemas';

// Deterministic rules (FR-4.1, FR-4.2): first enabled match wins.

/** The signed-in user the rules are evaluated for. */
export interface Me {
  id: string; // Slack user id
  mentionRe?: RegExp; // plain-text mentions such as "@frank"; `<@id>` mentions always match
}

/** The values behind a named list: VIPs hold for every source, the channel lists are Slack's. */
const namedList = (list: NamedList, s: Settings): string[] => (list === 'vips' ? s.people.vips : s.slack[list]);

const listValues = (c: { list?: NamedList; values: string[] }, s: Settings): string[] => [...(c.list ? namedList(c.list, s) : []), ...c.values];

export const toRegExp = (pattern: string): RegExp => {
  const m = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  return m ? new RegExp(m[1], m[2]) : new RegExp(pattern, 'i');
};

/** Whether a message mentions the user: a Slack `<@id>` mention, or the plain-text pattern. */
export const mentionsMe = (text: string, me: Me) => (!!me.id && text.includes(`<@${me.id}>`)) || (me.mentionRe?.test(text) ?? false);

function matches(c: RuleCondition, item: Item, s: Settings, me: Me): boolean {
  const others = item.messages.filter((m) => m.authorId !== me.id);
  switch (c.type) {
    case 'is_dm':
      return item.kind === 'dm';
    case 'mentions_me':
      return item.messages.some((m) => mentionsMe(m.text, me));
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

/**
 * The sources whose items are checked against the rules (FR-4.1). Items from other sources go
 * straight to the model. A source joins once its adapter fills the fields its conditions read.
 */
export const RULE_SOURCES: readonly SourceId[] = ['slack', 'outlook'];

export function firstMatchingRule(item: Item, rules: Rule[], settings: Settings, me: Me): Rule | undefined {
  if (!RULE_SOURCES.includes(item.source)) return undefined;
  return rules.find((r) => r.enabled && ruleSources(r).includes(item.source) && r.conditions.every((c) => matches(c, item, settings, me)));
}
