import type { ReactNode } from 'react';
import type { StartupFailure } from '../api';
import { Icon, type IconName } from '../components/icons';
import { Button, Spinner } from '../components/ui';

function Screen({ icon, tone, title, children, action }: { icon: IconName | 'spinner'; tone: 'bad' | 'neutral'; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4 py-10">
      <div className="flex w-full max-w-[560px] flex-col gap-5 rounded-[14px] border border-line bg-surface p-8 shadow-[0_1px_2px_rgba(20,23,28,0.06)]">
        <div className={tone === 'bad' ? 'text-red-fg' : 'text-accent'}>{icon === 'spinner' ? <Spinner size={28} /> : <Icon name={icon} size={28} />}</div>
        <div className="flex flex-col gap-2">
          <div className="font-mono text-[11px] text-muted">Work OS · local · 127.0.0.1</div>
          <h1 className="m-0 text-2xl font-semibold tracking-tight">{title}</h1>
        </div>
        <div className="flex flex-col gap-3 text-sm leading-relaxed text-ink-2">{children}</div>
        {action}
      </div>
    </main>
  );
}

const Code = ({ children }: { children: ReactNode }) => (
  <code className="block rounded-lg bg-tray px-3 py-2 font-mono text-[13px] text-ink">{children}</code>
);

export function UnreachableScreen({ reconnecting, onRetry }: { reconnecting: boolean; onRetry: () => void }) {
  if (reconnecting) {
    return (
      <Screen icon="spinner" tone="neutral" title="Reconnecting to Work OS…">
        <p className="m-0">The connection to the local server dropped, often because the laptop just woke up. Retrying every 5 seconds. Nothing is lost: state lives in the event log.</p>
      </Screen>
    );
  }
  return (
    <Screen icon="wifiOff" tone="bad" title="Can’t reach the Work OS server" action={<Button variant="solid" icon="poll" onClick={onRetry}>Try again</Button>}>
      <p className="m-0">The server runs on this Mac, bound to 127.0.0.1, and serves this page. It has stopped or hasn’t started yet.</p>
      <ol className="m-0 flex list-decimal flex-col gap-2 pl-5">
        <li>Start it from the repo: <Code>npm run dev</Code></li>
        <li>If it exits straight away, read the last lines of <span className="font-mono text-[13px]">~/WorkOS-data/logs/app-&lt;date&gt;.log</span>.</li>
        <li>Another instance may hold <span className="font-mono text-[13px]">state/lock</span>. Only one can run at a time.</li>
      </ol>
    </Screen>
  );
}

const STARTUP: Record<StartupFailure, { title: string; body: ReactNode; fix: ReactNode }> = {
  api_key: {
    title: 'Work OS refused to start',
    body: (
      <p className="m-0">
        <span className="font-mono text-[13px]">ANTHROPIC_API_KEY</span> is set in the server’s environment. Work OS runs on your Claude subscription through the Agent SDK, and the SDK would quietly bill the key instead (CL-2).
      </p>
    ),
    fix: (
      <>
        <p className="m-0">Remove the export from your shell profile, open a new terminal, then restart:</p>
        <Code>unset ANTHROPIC_API_KEY &amp;&amp; npm run dev</Code>
      </>
    ),
  },
  slack_token: {
    title: 'No Slack token in the Keychain',
    body: <p className="m-0">The startup check found no Slack user token. Work OS reads Slack with read-only scopes and never stores the token in a file (FR-2.2).</p>,
    fix: (
      <>
        <p className="m-0">Install the internal Slack app (P0-1), then store the user token:</p>
        <Code>security add-generic-password -s work-os -a slack-user-token -w</Code>
      </>
    ),
  },
  claude_login: {
    title: 'Claude login failed',
    body: <p className="m-0">The startup check made one minimal Haiku call and it was refused: not logged in. Triage and drafts can’t run without it (FR-12.2).</p>,
    fix: (
      <>
        <p className="m-0">Log in with your PSG Claude account, then restart the server:</p>
        <Code>claude login</Code>
      </>
    ),
  },
};

export function StartupFailedScreen({ failure, onRetry }: { failure: StartupFailure; onRetry: () => void }) {
  const s = STARTUP[failure];
  return (
    <Screen icon="alert" tone="bad" title={s.title} action={<Button variant="solid" icon="poll" onClick={onRetry}>Check again</Button>}>
      {s.body}
      <div className="flex flex-col gap-2 rounded-[10px] border border-line p-4">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted">How to fix it</div>
        {s.fix}
      </div>
    </Screen>
  );
}
