import { Suspense, lazy, useEffect, useRef } from 'react';
import { Outlet, createBrowserRouter, useLocation, useNavigate } from 'react-router';
import { RouterProvider } from 'react-router/dom'; // wires up flushSync, for navigations that need it
import { API_MODE, api } from './api';
import { Shell } from './components/Shell';
import { Toasts } from './components/Toasts';
import { onTopics, useApiQuery } from './hooks/useApiQuery';
import { ConnectionContext } from './hooks/useConnection';
import { TYPE_LABEL } from './lib/lanes';
import { EvalReportPage } from './pages/EvalReport';
import { InboxPage } from './pages/Inbox';
import { ItemDetailPage } from './pages/ItemDetail';
import { SettingsPage } from './pages/Settings';
import { SourcePage } from './pages/Source';
import { ReconnectingBar, StartupFailedScreen, UnreachableScreen } from './pages/SystemScreens';
import { UsagePage } from './pages/Usage';
import { ScenarioDrawer } from './scenarios/ScenarioDrawer';
import { takeQuiet } from './store/quietDrafts';
import { usePrefs } from './store/prefs';
import { unwatch, watchedFor } from './store/closeOnFile';
import { errorToast, toast, useToasts } from './store/toasts';

// The guide carries its own Markdown and renderer, so it loads only when opened.
const GuidePage = lazy(() => import('./pages/Guide').then((m) => ({ default: m.GuidePage })));

// The Scenarios drawer drives the mock; the real app has nothing for it to drive (and, API_MODE
// being a build-time constant, doesn't carry it).

function useThemeAttribute() {
  const theme = usePrefs((s) => s.theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
}

/** Turns server notices into macOS-style notifications and "draft ready" and "draft failed" toasts. */
function useNoticeToasts() {
  const location = useLocation();
  const navigate = useNavigate();
  const path = useRef(location.pathname);
  const search = useRef(location.search);
  useEffect(() => {
    path.current = location.pathname;
    search.current = location.search;
  }, [location.pathname, location.search]);
  // Already in front of Frank: the item's page, or the inbox panel open on it.
  const showing = (itemId: string) => path.current === `/item/${encodeURIComponent(itemId)}` || (path.current === '/' && new URLSearchParams(search.current).get('item') === itemId);
  useEffect(
    () =>
      api.subscribe((n) => {
        if (n.topic === 'notification') useToasts.getState().notify({ itemId: n.itemId, title: n.title, summary: n.summary });
        if (n.topic === 'draft_ready' && !takeQuiet(n.itemId) && !showing(n.itemId)) {
          toast(`${TYPE_LABEL[n.type].short} draft ready · ${n.title}`, {
            tone: 'success',
            action: { label: 'Review', run: () => navigate(`/item/${encodeURIComponent(n.itemId)}`) },
          });
        }
        // The bell keeps it too (FR-11.4); the toast is for when Frank is here.
        if (n.topic === 'draft_failed' && !takeQuiet(n.itemId) && !showing(n.itemId)) {
          toast(`${TYPE_LABEL[n.type].short} draft failed · ${n.title}`, {
            tone: 'error',
            description: n.message || undefined,
            ttl: 9000,
            action: { label: 'Open', run: () => navigate(`/item/${encodeURIComponent(n.itemId)}`) },
          });
        }
      }),
    [navigate],
  );
}

/** ? opens the keyboard shortcuts, from anywhere but a text field. */
function useHelpKey() {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [data-no-shortcuts]')) return;
      e.preventDefault();
      navigate('/guide/shortcuts');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate]);
}

/**
 * Close on file (UX-4): an approval that asked for its To file item to be closed once filed is
 * watched until its write lands. If the item closed, a toast says so, with Undo.
 */
function useCloseOnFileToasts() {
  useEffect(
    () =>
      api.subscribe((n) => {
        if (n.topic !== 'item') return;
        const watched = watchedFor(n.id);
        if (!watched.length) return;
        void api.getItem(n.id).then((v) => {
          for (const [actionId, w] of watched) {
            const a = v.actions.find((x) => x.id === actionId);
            if (a && (a.status === 'approved' || a.status === 'executing')) continue;
            unwatch(actionId);
            if (a?.status === 'done' && v.summary.status === 'done' && (v.summary.doneBy ?? 'you') === 'you')
              toast(`Filed, so marked done · ${w.title}`, { tone: 'success', action: { label: 'Undo', run: () => void api.reopen(n.id).catch(errorToast) } });
          }
        }, () => undefined);
      }),
    [],
  );
}

/** z runs the newest Undo a toast offered, even after the toast has gone (UX-1). */
function useUndoKey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'z' || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [data-no-shortcuts]')) return;
      e.preventDefault();
      const u = useToasts.getState().undo();
      toast(u ? `Undone: ${u.message}` : 'Nothing to undo.', { key: 'undo' });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

const guide = (
  <Suspense fallback={<div className="h-full bg-surface" />}>
    <GuidePage />
  </Suspense>
);

function Root() {
  useThemeAttribute();
  useNoticeToasts();
  useHelpKey();
  useUndoKey();
  useCloseOnFileToasts();
  const health = useApiQuery(() => api.getHealth(), onTopics('health'), []);
  const h = health.data;
  let body = <Outlet />;
  // A first load that failed some other way still says so, rather than leaving the page blank.
  if (!h) body = health.error ? <UnreachableScreen onRetry={health.reload} /> : <div className="min-h-screen bg-bg" />;
  // Reconnecting keeps the page, so an edit in progress survives a blip; only down replaces it.
  else if (h.connection === 'down') body = <UnreachableScreen onRetry={health.reload} />;
  else if (h.startupFailure) body = <StartupFailedScreen failure={h.startupFailure} onRetry={health.reload} />;
  return (
    <ConnectionContext value={h?.connection ?? 'up'}>
      {h?.connection === 'reconnecting' && !h.startupFailure && <ReconnectingBar />}
      {body}
      <Toasts />
      {API_MODE === 'mock' && <ScenarioDrawer />}
    </ConnectionContext>
  );
}

const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      {
        element: <Shell />,
        children: [
          { index: true, element: <InboxPage /> },
          { path: 'source/:id', element: <SourcePage /> },
          { path: 'usage', element: <UsagePage /> },
          { path: 'usage/eval/:id', element: <EvalReportPage /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: 'settings/:section', element: <SettingsPage /> },
          { path: 'guide', element: guide },
          { path: 'guide/:page', element: guide },
        ],
      },
      { path: 'item/:id', element: <ItemDetailPage /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
