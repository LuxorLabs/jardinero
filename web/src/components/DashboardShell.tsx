import logoUrl from '@/assets/jardinero_logo.svg';
import { KpiCard } from '@/components/KpiCard';
import { PageHeader } from '@/components/layout';
import { ThemeToggle } from '@/components/ThemeToggle';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useLive } from '@/live/LiveProvider';
import {
  Activity,
  Bot,
  GitPullRequest,
  Inbox,
  Layers,
  type LucideIcon,
  Play,
  ScrollText,
  Tag,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import { Suspense, lazy } from 'react';

// Each tab is a full-page route selected by the server-rendered shell, so a
// route only ever renders one tab. Loading them lazily keeps each route's
// payload to its own tab chunk plus the shared runtime.
const OverviewTab = lazy(() =>
  import('@/tabs/OverviewTab').then((m) => ({ default: m.OverviewTab })),
);
const OperationTab = lazy(() =>
  import('@/tabs/OperationTab').then((m) => ({ default: m.OperationTab })),
);
const RequestsTab = lazy(() =>
  import('@/tabs/RequestsTab').then((m) => ({ default: m.RequestsTab })),
);
const PrsTab = lazy(() => import('@/tabs/PrsTab').then((m) => ({ default: m.PrsTab })));
const EventsTab = lazy(() => import('@/tabs/EventsTab').then((m) => ({ default: m.EventsTab })));
const PromptsTab = lazy(() => import('@/tabs/PromptsTab').then((m) => ({ default: m.PromptsTab })));

export type DashboardTab = 'overview' | 'operation' | 'requests' | 'prs' | 'events' | 'prompts';

export function tabFromPath(pathname: string): DashboardTab {
  if (pathname === '/dashboard/operation') return 'operation';
  if (pathname === '/dashboard/requests') return 'requests';
  if (pathname === '/dashboard/prs') return 'prs';
  if (pathname === '/dashboard/events') return 'events';
  if (pathname === '/dashboard/prompts') return 'prompts';
  return 'overview';
}

const TABS: Array<{ id: DashboardTab; label: string; href: string; Icon: LucideIcon }> = [
  { id: 'overview', label: 'Factory Overview', href: '/dashboard', Icon: Zap },
  { id: 'operation', label: 'Operation', href: '/dashboard/operation', Icon: Activity },
  { id: 'requests', label: 'Requests', href: '/dashboard/requests', Icon: Inbox },
  { id: 'prs', label: 'Pull requests', href: '/dashboard/prs', Icon: GitPullRequest },
  { id: 'events', label: 'Event logs', href: '/dashboard/events', Icon: ScrollText },
  { id: 'prompts', label: 'Prompts', href: '/dashboard/prompts', Icon: Bot },
];

export function DashboardShell({ tab }: { tab: DashboardTab }) {
  const { snapshot, liveState, liveMessage } = useLive();
  const sandboxes =
    snapshot === null ? '--' : `${snapshot.sandboxes_running} / ${snapshot.sandboxes_cap}`;

  return (
    <main className="grid min-h-screen content-start">
      <header
        className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 border-border border-b bg-white px-6 py-2.5"
        aria-label="Dashboard header"
      >
        <img src={logoUrl} alt="Jardinero" className="app-logo h-7 w-auto justify-self-start" />

        <nav
          className="flex items-center gap-1 justify-self-center rounded-xl border border-border bg-white p-1"
          aria-label="Dashboard sections"
        >
          {TABS.map((entry) => {
            const active = entry.id === tab;
            const { Icon } = entry;
            return (
              <a
                key={entry.id}
                href={entry.href}
                aria-current={active ? 'page' : 'false'}
                aria-label={entry.label}
                className={cn(
                  'inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 font-normal text-slate transition-colors',
                  active
                    ? 'bg-nav-active text-white hover:bg-nav-active/90'
                    : 'hover:bg-foreground/5 hover:text-ink',
                )}
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                <span className="max-[1280px]:hidden">{entry.label}</span>
              </a>
            );
          })}
        </nav>

        <div className="flex items-center gap-3 justify-self-end" aria-live="polite">
          <ThemeToggle />
          <span
            id="live-indicator"
            className={cn(
              'inline-flex whitespace-nowrap rounded-full border px-2.5 py-[7px] font-[750] text-[13px] max-[1024px]:hidden',
              liveState === 'live'
                ? 'border-success-border bg-success-bg text-success-fg'
                : 'border-notice-border bg-notice-bg text-notice-fg',
            )}
          >
            {liveMessage}
          </span>
          <span className="group relative hidden max-[1024px]:inline-flex">
            <button
              type="button"
              aria-label={liveMessage}
              className="inline-flex size-8 items-center justify-center rounded-full border border-border bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                className={cn(
                  'jardinero-pulse-dot inline-block size-2.5 rounded-full',
                  liveState === 'live' ? 'bg-pulse' : 'bg-notice-fg',
                )}
                style={
                  liveState === 'live'
                    ? { animation: 'jardinero-pulse 1.8s ease-in-out infinite' }
                    : undefined
                }
              />
            </button>
            <span
              role="tooltip"
              className="pointer-events-none absolute top-full right-0 z-10 mt-2 hidden whitespace-nowrap rounded-md border border-border bg-popover px-2.5 py-1 text-[13px] text-popover-foreground shadow-md group-hover:block group-focus-within:block"
            >
              {liveMessage}
            </span>
          </span>
        </div>
      </header>

      <div className="grid content-start gap-5 p-6">
        {tab === 'overview' && (
          <>
            <PageHeader
              title="Factory Overview"
              description="What each machine is holding, what it produced, and what is waiting for a person."
              right={
                <span className="whitespace-nowrap font-bold text-[13px] text-muted-foreground">
                  {snapshot?.updated_at
                    ? `Updated ${formatRelativeTime(snapshot.updated_at)}`
                    : 'Waiting for data'}
                </span>
              }
            />
            <section
              className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
              aria-label="Factory status"
            >
              <KpiCard
                label="Sandboxes running"
                value={sandboxes}
                id="sandboxes-running"
                Icon={Play}
                featured
                index={0}
              />
              <KpiCard
                label="Open instances"
                value={snapshot?.open_instances ?? '--'}
                id="open-instances"
                Icon={Layers}
                index={1}
              />
              <KpiCard
                label="Requires attention"
                value={snapshot?.requires_attention ?? '--'}
                id="requires-attention"
                Icon={TriangleAlert}
                index={2}
              />
              <KpiCard
                label="Version"
                value={snapshot?.app_version ?? '--'}
                id="app-version"
                Icon={Tag}
                index={3}
              />
            </section>
          </>
        )}

        <Suspense fallback={null}>
          {tab === 'overview' && <OverviewTab />}
          {tab === 'operation' && <OperationTab />}
          {tab === 'requests' && <RequestsTab />}
          {tab === 'prs' && <PrsTab />}
          {tab === 'events' && <EventsTab />}
          {tab === 'prompts' && <PromptsTab />}
        </Suspense>
      </div>
    </main>
  );
}
