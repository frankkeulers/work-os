import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from './config/env';
import { fakesRefusal } from './fakes';
import { run } from './start';

describe('--fakes', () => {
  const config = (dir: string, instance = 'dev') => resolveConfig({ WORKOS_INSTANCE: instance, WORKOS_DATA_DIR: dir, WORKOS_ALLOW_PROD_DATA: '1' }, '/Users/test');

  it('runs only on the development instance, in a temp data directory', () => {
    expect(fakesRefusal(config(join(tmpdir(), 'workos-e2e', 'data')))).toBeUndefined();
    expect(fakesRefusal(config(join(tmpdir(), 'x'), 'prod'))).toMatch(/development instance/);
    expect(fakesRefusal(config('/Users/test/WorkOS-data-dev'))).toMatch(/under/);
    expect(fakesRefusal(config(join(tmpdir(), '..', 'escape')))).toMatch(/under/);
  });

  it('refuses to start against a real data directory', async () => {
    const res = await run({ env: { WORKOS_INSTANCE: 'dev', WORKOS_DATA_DIR: join(process.env.HOME ?? '/Users/x', 'WorkOS-data-dev'), WORKOS_PORT: '0' }, fakes: true });
    expect(res).toEqual({ running: false, code: 78 });
  });
});
