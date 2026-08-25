import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { DashboardSnapshot, LiveState, OverviewResponse } from '@shared';
import { getJson } from '@/lib/api';

// Mirrors the legacy live-update engine (server.ts:3976-4188): an SSE stream with
// a 5s polling fallback that only runs while the stream is unhealthy, plus a
// single connection indicator. Tabs subscribe to `refreshSignal` to refetch.

interface LiveContextValue {
  liveState: LiveState;
  liveMessage: string;
  /** Latest snapshot (running/pending/pause) for the global status strip. */
  snapshot: DashboardSnapshot | OverviewResponse | null;
  /** Bumps on every SSE snapshot and successful poll; tabs refetch on change. */
  refreshSignal: number;
  /** Lets tab refreshers flag a degraded state on their own failures. */
  setLive: (state: LiveState, message: string) => void;
}

const LiveContext = createContext<LiveContextValue | null>(null);

export function useLive(): LiveContextValue {
  const value = useContext(LiveContext);
  if (!value) throw new Error('useLive must be used within LiveProvider');
  return value;
}

const POLL_INTERVAL_MS = 5000;

export function LiveProvider({ children }: { children: ReactNode }) {
  const [liveState, setLiveStateValue] = useState<LiveState>('degraded');
  const [liveMessage, setLiveMessage] = useState('Connecting');
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | OverviewResponse | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);

  const healthyRef = useRef(false);
  const bumpSignal = useCallback(() => setRefreshSignal((value) => value + 1), []);

  const setLive = useCallback((state: LiveState, message: string) => {
    healthyRef.current = state === 'live';
    setLiveStateValue(state);
    setLiveMessage(message);
  }, []);

  useEffect(() => {
    let cancelled = false;

    // refreshDashboardStatus(): poll /overview, update strip, signal tabs.
    const poll = async () => {
      try {
        const data = await getJson<OverviewResponse>('/dashboard/api/overview', {
          errorMessage: 'dashboard refresh failed',
        });
        if (cancelled) return;
        setSnapshot(data);
        bumpSignal();
        if (!healthyRef.current) {
          setLive('degraded', 'Live updates degraded; polling backup active');
        }
      } catch {
        if (!cancelled) setLive('degraded', 'Live updates degraded; retrying');
      }
    };

    // Startup parity: initial status poll, then connect SSE, then arm the timer.
    void poll();

    let source: EventSource | undefined;
    if (typeof EventSource !== 'undefined') {
      source = new EventSource('/dashboard/api/stream');
      source.addEventListener('dashboard.connected', () => {
        setLive('live', 'Live updates connected');
      });
      source.addEventListener('dashboard.snapshot', (event) => {
        setLive('live', 'Live updates connected');
        try {
          setSnapshot(JSON.parse((event as MessageEvent).data));
        } catch {
          // Ignore malformed payloads; the next snapshot/poll recovers.
        }
        bumpSignal();
      });
      source.onerror = () => {
        setLive('degraded', 'Live updates degraded; retrying');
      };
    } else {
      setLive('degraded', 'Live updates unavailable; polling backup active');
    }

    const timer = window.setInterval(() => {
      if (!healthyRef.current) void poll();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (source) source.close();
      window.clearInterval(timer);
    };
  }, [setLive, bumpSignal]);

  return (
    <LiveContext.Provider value={{ liveState, liveMessage, snapshot, refreshSignal, setLive }}>
      {children}
    </LiveContext.Provider>
  );
}
