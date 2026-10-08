import type { ModelId, Settings } from '@work-os/shared';
import type { SecretStore } from '../config/keychain';
import { ClaudeError } from './errors';

// Which account the SDK uses (CL-8). One setting switches it, nothing else changes:
//   subscription  Frank's Claude login (the default and the goal, CL-2)
//   api_key       a key from the Keychain, given to the SDK's own process only
//   bedrock       AWS credentials from the usual AWS configuration
// The server's own environment never carries a key (CL-2 refuses to start with one), and the
// SDK's environment is built from scratch for each call, so a backend can't leak into another.

export const API_KEY_ACCOUNT = 'anthropic-api-key';

/**
 * How each of the settings' models is called: the SDK's name for it, and thinking as near to off as
 * the model allows. Sonnet 5.5 and Opus 5.5 refuse thinking: disabled, so they think adaptively at
 * low effort, the lowest setting the SDK offers them.
 */
export const MODEL_CALL: Record<ModelId, { sdk: string; thinking: { type: 'disabled' | 'adaptive' }; effort?: 'low' }> = {
  'haiku-4.5': { sdk: 'claude-haiku-4-5', thinking: { type: 'disabled' } },
  'haiku-5.5': { sdk: 'claude-haiku-5-5', thinking: { type: 'disabled' } },
  'sonnet-5.5': { sdk: 'claude-sonnet-5-5', thinking: { type: 'adaptive' }, effort: 'low' },
  'opus-5.5': { sdk: 'claude-opus-5-5', thinking: { type: 'adaptive' }, effort: 'low' },
};

const ACCOUNT_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];

export async function backendEnv(backend: Settings['claudeBackend'], base: NodeJS.ProcessEnv, secrets: SecretStore, client: string): Promise<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = { ...base, CLAUDE_AGENT_SDK_CLIENT_APP: client };
  for (const v of ACCOUNT_VARS) delete env[v];
  if (backend === 'bedrock') env.CLAUDE_CODE_USE_BEDROCK = '1';
  if (backend === 'api_key') {
    const key = await secrets.get(API_KEY_ACCOUNT).catch(() => undefined);
    if (!key) throw new ClaudeError({ state: 'auth_failed', reason: 'no API key in the Keychain' }, `Settings choose an API key, but the Keychain has none under "${API_KEY_ACCOUNT}".`);
    env.ANTHROPIC_API_KEY = key;
  }
  return env;
}
