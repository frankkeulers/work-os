import { useState } from 'react';
import type { DependencyHealth, HealthView, StartupCheck } from '../api';
import { api } from '../api';
import { onTopics, useApiQuery } from '../hooks/useApiQuery';
import { errorToast } from '../store/toasts';
import { Banner, Button, Spinner } from './ui';

// Degraded and safe mode (FR-12.2, FR-14.6): the server keeps running and says what is wrong, with
// the fix and a "Check again" button, instead of a blocking screen. Slack's own token and
// rate-limit trouble has its banner on the inbox, so it isn't repeated here.

const DEP_LABEL: Record<DependencyHealth['id'], string> = {
  network: 'Network',
  slack: 'Slack',
  claude: 'Claude',
  confluence: 'Confluence',
  keychain: 'Keychain',
  storage: 'Data disk',
  wisprDb: 'Wispr Flow',
};

const STATE_LABEL: Partial<Record<DependencyHealth['state'], string>> = {
  offline: 'offline',
  degraded: 'not working',
  rate_limited: 'rate-limiting',
  auth_failed: 'rejected the login',
  paused: 'paused',
};

export interface Problem {
  key: string;
  title: string;
  fix?: string;
}

/** What to show, most pressing first. */
export function problemsOf(h: HealthView): Problem[] {
  const out: Problem[] = [];
  const failed = (c: StartupCheck) => c.status === 'fail';
  for (const c of h.checks.filter(failed)) out.push({ key: `check:${c.id}`, title: `${c.label}: ${c.note}` });
  const shownOnInbox = (d: DependencyHealth) => d.id === 'slack' && (d.state === 'auth_failed' || d.state === 'rate_limited');
  for (const d of h.deps) {
    if (d.state === 'ok' || d.state === 'unknown' || shownOnInbox(d)) continue;
    // A failed check already says it for the Keychain.
    if (d.id === 'keychain' && out.some((p) => p.key === 'check:keychain')) continue;
    out.push({ key: `dep:${d.id}`, title: `${DEP_LABEL[d.id]} ${STATE_LABEL[d.state] ?? d.state}${d.reason === 'captive_portal' ? ' (Wi-Fi sign-in page)' : ''}`, fix: d.fix });
  }
  return out;
}

export function HealthBanner() {
  const health = useApiQuery(() => api.getHealth(), onTopics('health'), []);
  const [checking, setChecking] = useState(false);
  const h = health.data;
  if (!h || h.connection !== 'up') return null;

  const recheck = async () => {
    setChecking(true);
    try {
      await api.recheck();
      health.reload();
    } catch (e) {
      errorToast(e);
    } finally {
      setChecking(false);
    }
  };
  const action = (
    <Button size="sm" icon={checking ? undefined : 'poll'} onClick={() => void recheck()} disabled={checking}>
      {checking && <Spinner size={12} />}
      Check again
    </Button>
  );

  if (h.mode === 'safe') {
    return (
      <div className="px-6 pt-3">
        <Banner tone="bad" icon="alert" action={action}>
          <strong>Safe mode.</strong> Work OS crashed several times in a few minutes, so polling is off. The inbox still works. Check again to resume; if it keeps crashing, the log in <span className="font-mono text-[12px]">~/WorkOS-data/logs</span> says why.
        </Banner>
      </div>
    );
  }
  if (h.phase === 'waking' || h.phase === 'catching_up') {
    return (
      <div className="px-6 pt-3">
        <Banner tone="info" icon="clock">
          <strong>Catching up after sleep.</strong> Checking the network, then polling what fell due while the Mac was asleep.
        </Banner>
      </div>
    );
  }
  const problems = h.mode === 'degraded' ? problemsOf(h) : [];
  if (!problems.length) return null;
  const [first, ...rest] = problems;
  return (
    <div className="px-6 pt-3">
      <Banner tone="warn" icon="alert" action={action}>
        <strong>Running with a problem.</strong> {first.title}.{first.fix ? ` ${first.fix}` : ''}
        {rest.length > 0 && (
          <span className="text-ink-2">
            {' '}
            Also: {rest.map((p) => p.title).join('; ')}.
          </span>
        )}
      </Banner>
    </div>
  );
}
