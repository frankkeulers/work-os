import { describe, expect, it } from 'vitest';
import { appHealth } from './health';

const claude = { title: 'Claude not working' };
const disk = { title: 'Data disk offline' };

describe('appHealth', () => {
  it('is fine when running normally', () => {
    expect(appHealth({ mode: 'normal', phase: 'running' }, [])).toEqual({ tone: 'ok', label: 'Running normally' });
  });

  it('names the first problem when degraded, and counts the rest', () => {
    expect(appHealth({ mode: 'degraded', phase: 'running' }, [claude])).toEqual({ tone: 'warn', label: 'Claude not working' });
    expect(appHealth({ mode: 'degraded', phase: 'running' }, [claude, disk])).toEqual({ tone: 'warn', label: 'Claude not working (+1 more)' });
  });

  it('stays fine when degraded only by a problem the inbox shows (Slack rate-limiting)', () => {
    expect(appHealth({ mode: 'degraded', phase: 'running' }, []).tone).toBe('ok');
  });

  it('says when it is catching up after sleep', () => {
    expect(appHealth({ mode: 'normal', phase: 'waking' }, []).tone).toBe('info');
    expect(appHealth({ mode: 'degraded', phase: 'catching_up' }, [claude]).tone).toBe('info');
  });

  it('puts safe mode first', () => {
    expect(appHealth({ mode: 'safe', phase: 'catching_up' }, [claude])).toEqual({ tone: 'bad', label: 'Safe mode: polling is off' });
  });

  it('says when it is stopping', () => {
    expect(appHealth({ mode: 'normal', phase: 'stopping' }, []).tone).toBe('idle');
  });
});
