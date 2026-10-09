import { describe, expect, it } from 'vitest';
import type { DependencyHealth, SourceHealth } from '@work-os/shared';
import { appHealth, pillHealth } from './health';

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

describe('pillHealth (cockpit CK-1.7)', () => {
  const now = new Date('2026-10-09T12:48:00Z'); // 13:48 London
  const ago = (mins: number) => new Date(now.getTime() - mins * 60_000).toISOString();
  const src = (id: SourceHealth['id'], mins: number, interval?: number): SourceHealth => ({ id, status: 'healthy', lastPollAt: ago(mins), intervalMinutes: interval, rateLimitedToday: 0 });
  const dep = (id: DependencyHealth['id'], state: DependencyHealth['state'], extra: Partial<DependencyHealth> = {}): DependencyHealth => ({ id, state, since: ago(30), failures: 1, ...extra });
  const running = { mode: 'normal' as const, phase: 'running' as const, deps: [dep('network', 'ok'), dep('slack', 'ok')] };
  const live = [src('slack', 2, 10), src('outlook', 9, 30)];

  it('says all sources are live, with the oldest read', () => {
    expect(pillHealth(running, live, now)).toEqual({ tone: 'ok', label: 'All sources live · 9 min ago' });
    expect(pillHealth(running, [], now)).toEqual({ tone: 'ok', label: 'All sources live' });
  });

  it('turns amber when a source’s last read is older than twice its interval', () => {
    const p = pillHealth(running, [src('slack', 34, 10), src('outlook', 9, 30)], now);
    expect(p).toMatchObject({ tone: 'warn', label: 'Slack stale · last read 34 min ago', fix: { to: '/usage#health' } });
    // Exactly twice is still on time; a source polling or queued now is on its way.
    expect(pillHealth(running, [src('slack', 20, 10)], now).tone).toBe('ok');
    expect(pillHealth(running, [src('slack', 34, 10)], now, { polling: 'slack' }).tone).toBe('ok');
    expect(pillHealth(running, [src('slack', 34, 10)], now, { queued: ['slack'] }).tone).toBe('ok');
    expect(pillHealth(running, [src('slack', 125, 10), src('outlook', 90, 30)], now).label).toBe('Slack stale · last read 2 h 5 min ago (+1 more)');
  });

  it('leaves out a source that doesn’t poll now (off hours with no off-hours polls) or never has', () => {
    expect(pillHealth(running, [src('wispr', 400, undefined)], now).tone).toBe('ok');
    expect(pillHealth(running, [{ ...src('slack', 400, 10), status: 'never' }], now).tone).toBe('ok');
  });

  it('names a dependency that is down, what is stale, and the fix', () => {
    const p = pillHealth({ ...running, mode: 'degraded', deps: [dep('ms365', 'auth_failed', { fix: 'Reconnect it on claude.ai.' })] }, live, now);
    expect(p).toEqual({
      tone: 'warn',
      label: 'Outlook not connected · mail and calendar stale',
      fix: { label: 'Reconnect on claude.ai', href: 'https://claude.ai/settings/connectors', title: 'Reconnect it on claude.ai.' },
    });
    const two = pillHealth({ ...running, mode: 'degraded', deps: [dep('slack', 'rate_limited'), dep('claude', 'auth_failed')] }, live, now);
    expect(two).toMatchObject({ tone: 'warn', label: 'Slack rate-limiting · Slack stale (+1 more)', fix: { to: '/usage#health' } });
  });

  it('puts a dependency that is down before staleness', () => {
    expect(pillHealth({ ...running, deps: [dep('network', 'offline')] }, [src('slack', 34, 10)], now).label).toBe('Network offline · nothing is being read');
  });

  it('puts safe mode first, then stopping, then catching up', () => {
    const down = [dep('claude', 'auth_failed')];
    expect(pillHealth({ mode: 'safe', phase: 'catching_up', deps: down }, live, now)).toEqual({
      tone: 'bad',
      label: 'Safe mode · nothing is being read',
      fix: { label: 'Open Usage & health', to: '/usage#health' },
    });
    expect(pillHealth({ mode: 'degraded', phase: 'stopping', deps: down }, live, now)).toEqual({ tone: 'idle', label: 'Stopping' });
    expect(pillHealth({ mode: 'degraded', phase: 'catching_up', deps: down }, live, now)).toEqual({ tone: 'info', label: 'Catching up after sleep' });
    expect(pillHealth({ ...running, phase: 'waking' }, live, now).tone).toBe('info');
  });
});
