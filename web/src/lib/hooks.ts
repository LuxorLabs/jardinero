import { useEffect, useState } from 'react';
import { getJson } from '@/lib/api';
import { useLive } from '@/live/LiveProvider';

// useDashboardResource refetches its url whenever the live stream says something
// changed, and reports a failure as a degraded connection.
export function useDashboardResource<T>(url: string, errorMessage: string): T | null {
  const { refreshSignal, setLive } = useLive();
  const [data, setData] = useState<T | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await getJson<T>(url, { errorMessage });
        if (!cancelled) setData(result);
      } catch {
        if (!cancelled) setLive('degraded', 'Live updates degraded; polling backup active');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, errorMessage, refreshSignal, setLive]);

  return data;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const update = () => setMatches(mediaQuery.matches);
    update();
    mediaQuery.addEventListener('change', update);
    return () => mediaQuery.removeEventListener('change', update);
  }, [query]);
  return matches;
}
