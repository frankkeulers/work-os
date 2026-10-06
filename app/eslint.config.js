import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

const SDK_ONLY = 'CL-1: only apps/server/src/claude/adapter.ts may use the Agent SDK.';

export default tseslint.config(
  { ignores: ['**/dist', '**/dist-mock', '**/node_modules', '**/test-results', '**/playwright-report'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2022, globals: { ...globals.browser, ...globals.node } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  // CL-1: only the Claude adapter talks to the Agent SDK, statically or through import().
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['apps/server/src/claude/adapter.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ regex: '^@anthropic-ai/claude-agent-sdk(/|$)', message: SDK_ONLY }] }],
      'no-restricted-syntax': ['error', { selector: 'ImportExpression[source.value=/^@anthropic-ai\\/claude-agent-sdk/]', message: SDK_ONLY }],
    },
  },
);
