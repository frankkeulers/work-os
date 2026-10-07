import { Suspense, lazy, useEffect, useRef } from 'react';
import { Outlet, RouterProvider, createBrowserRouter, useLocation, useNavigate } from 'react-router';
import { API_MODE, api } from './api';
import { Shell } from './components/Shell';
import { Toasts } from './components/Toasts';
import { onTopics, useApiQuery } from './hooks/useApiQuery';
import { TYPE_LABEL } from './lib/lanes';
import { EvalReportPage } from './pages/EvalReport';
import { InboxPage } from './pages/Inbox';
import { ItemDetailPage } from './pages/ItemDetail';
import { SettingsPage } from './pages/Settings';
import { StartupFailedScreen, UnreachableScreen } from './pages/SystemScreens';
import { UsagePage } from './pages/Usage';
import { ScenarioDrawer } from './scenarios/ScenarioDrawer';
import { usePrefs } from './store/prefs';
import { toast, useToasts } from './store/toasts';

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

/** Turns server notices into macOS-style notifications and "draft ready" toasts. */
function useNoticeToasts() {
  const location = useLocation();
  const navigate = useNavigate();
  const path = useRef(location.pathname);
  useEffect(() => {
    path.current = location.pathname;
  }, [location.pathname]);
  useEffect(
    () =>
      api.subscribe((n) => {
        if (n.topic === 'notification') useToasts.getState().notify({ itemId: n.itemId, title: n.title, summary: n.summary });
        if (n.topic === 'draft_ready' && path.current !== `/item/${encodeURIComponent(n.itemId)}`) {
          toast(`${TYPE_LABEL[n.type].short} draft ready · ${n.title}`, {
            tone: 'success',
            action: { label: 'Review', run: () => navigate(`/item/${encodeURIComponent(n.itemId)}`) },
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

const guide = (
  <Suspense fallback={<div className="min-h-screen bg-surface" />}>
    <GuidePage />
  </Suspense>
);

function Root() {
  useThemeAttribute();
  useNoticeToasts();
  useHelpKey();
  const health = useApiQuery(() => api.getHealth(), onTopics('health'), []);
  const h = health.data;
  let body = <Outlet />;
  // A first load that failed some other way still says so, rather than leaving the page blank.
  if (!h) body = health.error ? <UnreachableScreen reconnecting={false} onRetry={health.reload} /> : <div className="min-h-screen bg-bg" />;
  else if (h.connection !== 'up') body = <UnreachableScreen reconnecting={h.connection === 'reconnecting'} onRetry={health.reload} />;
  else if (h.startupFailure) body = <StartupFailedScreen failure={h.startupFailure} onRetry={health.reload} />;
  return (
    <>
      {body}
      <Toasts />
      {API_MODE === 'mock' && <ScenarioDrawer />}
    </>
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
