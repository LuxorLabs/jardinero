import { DashboardShell, tabFromPath } from '@/components/DashboardShell';
import { LiveProvider } from '@/live/LiveProvider';

export function App() {
  // Tab is chosen by the server-served page route; there is no client routing
  // (tab links are full-page navigations, matching the legacy dashboard).
  const tab = tabFromPath(window.location.pathname);
  return (
    <LiveProvider>
      <DashboardShell tab={tab} />
    </LiveProvider>
  );
}
