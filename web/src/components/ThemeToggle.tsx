import { cn } from '@/lib/utils';
import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'jardinero-dashboard-theme';

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'light';

  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const isDark = theme === 'dark';

  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Storage may be unavailable in locked-down browsers; the live toggle still works.
    }
  }, [theme]);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={`Dashboard theme: ${isDark ? 'dark' : 'light'}`}
      className="inline-flex h-9 items-center gap-1 rounded-full border border-control bg-secondary p-1 text-secondary-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      <span
        className={cn(
          'inline-flex size-7 items-center justify-center rounded-full transition-colors',
          !isDark && 'bg-white text-ink shadow-sm',
        )}
      >
        <Sun aria-hidden="true" className="size-4" />
      </span>
      <span
        className={cn(
          'inline-flex size-7 items-center justify-center rounded-full transition-colors',
          isDark && 'bg-white text-ink shadow-sm',
        )}
      >
        <Moon aria-hidden="true" className="size-4" />
      </span>
    </button>
  );
}
