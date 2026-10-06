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

/** The SDK's model names for the settings' model IDs. */
export const SDK_MODEL: Record<ModelId, string> = {
  'haiku-4.5': 'claude-haiku-4-5',
  'sonnet-5.5': 'claude-sonnet-5',
  'opus-5.5': 'claude-opus-5-5',
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
