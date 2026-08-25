import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

interface RevealOptions {
  // Stagger offset in ms, applied as the CSS animation-delay once revealed.
  delay?: number;
}

interface RevealBinding {
  ref: (node: Element | null) => void;
  className: string;
  style: CSSProperties | undefined;
}

const revealCallbacks = new Map<Element, () => void>();
let sharedRevealObserver: IntersectionObserver | undefined;

function getRevealObserver(): IntersectionObserver | undefined {
  if (typeof IntersectionObserver === 'undefined') return undefined;
  if (!sharedRevealObserver) {
    sharedRevealObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const reveal = revealCallbacks.get(entry.target);
          if (!reveal) continue;
          revealCallbacks.delete(entry.target);
          sharedRevealObserver?.unobserve(entry.target);
          reveal();
        }
      },
      { threshold: 0.08, rootMargin: '0px 0px -40px 0px' },
    );
  }
  return sharedRevealObserver;
}

// Reveals an element the first time it scrolls into view: returns a callback
// ref plus the class/style to spread onto an existing element, so it never adds
// a wrapper that could break a grid or table layout. Fires once, then detaches.
export function useReveal(options: RevealOptions = {}): RevealBinding {
  const { delay = 0 } = options;
  const [node, setNode] = useState<Element | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!node || visible) return;
    const observer = getRevealObserver();
    if (!observer) {
      setVisible(true);
      return;
    }
    const reveal = () => setVisible(true);
    revealCallbacks.set(node, reveal);
    observer.observe(node);
    return () => {
      if (revealCallbacks.get(node) !== reveal) return;
      revealCallbacks.delete(node);
      observer.unobserve(node);
    };
  }, [node, visible]);

  return {
    ref: setNode,
    className: visible ? 'reveal is-visible' : 'reveal',
    style: delay ? ({ '--reveal-delay': `${delay}ms` } as CSSProperties) : undefined,
  };
}

// Convenience wrapper for grouping arbitrary children; only use where an extra
// block-level div is layout-safe. For grid/table children, prefer useReveal on
// the element itself.
export function Reveal({
  children,
  delay,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const reveal = useReveal({ delay });
  return (
    <div ref={reveal.ref} className={cn(reveal.className, className)} style={reveal.style}>
      {children}
    </div>
  );
}
