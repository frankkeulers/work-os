// Where the app's contextual "Guide" links point: <page slug>#<heading id>. Kept apart from the
// guide's content so the links don't pull the pages and the renderer into the main bundle;
// guide.test.ts checks that every target exists.

export const HELP = {
  rules: 'rules',
  scope: 'confluence#scope',
  noFit: 'confluence#no-fit',
  refusedWrites: 'confluence#refused-writes',
  prompts: 'prompts',
  wispr: 'wispr-flow',
  health: 'troubleshooting#health',
  shortcuts: 'shortcuts',
} as const;

export type HelpTopic = keyof typeof HELP;
