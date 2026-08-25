import { logger } from './logger.js';

// MAX_WAIT_MS is longer than anything legitimate holds a lock, so a lapse means a
// handler did not release.
const MAX_WAIT_MS = 30_000;

const log = logger.child('locker');

// Lock is a held lock, released by whoever took it.
export interface Lock {
  release(): void;
}

export interface Locker {
  // acquire takes the lock on a resource, waiting for whoever holds it, and answers
  // undefined when the wait runs out.
  acquire(resourceId: string): Promise<Lock | undefined>;
}

// InMemoryLocker locks within this process, which is all a single-process
// orchestrator needs; multi-instance swaps this for Redis or SQLite.
export class InMemoryLocker implements Locker {
  // The tail of the queue per resource. Awaiting it is waiting for everyone
  // already in line, and replacing it is taking a place at the end.
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly maxWaitMs: number = MAX_WAIT_MS) {}

  async acquire(resourceId: string): Promise<Lock | undefined> {
    const ahead = this.queues.get(resourceId) ?? Promise.resolve();
    let releaseMine: (() => void) | undefined;
    const mine = new Promise<void>((resolve) => {
      releaseMine = resolve;
    });
    const tail = ahead.then(() => mine);
    this.queues.set(resourceId, tail);

    if (!(await waitFor(ahead, this.maxWaitMs))) {
      log.error('gave up waiting for a lock', {
        resource_id: resourceId,
        waited_ms: this.maxWaitMs,
      });
      // The place in line is still ours, and letting it go now would let the
      // next caller in while the holder is still working.
      releaseMine?.();
      return undefined;
    }

    let released = false;
    return {
      release: () => {
        // Releasing twice would hand the resource to two waiters at once.
        if (released) return;
        released = true;
        // Nobody queued behind, so the entry would leak for a resource that may
        // never come back.
        if (this.queues.get(resourceId) === tail) this.queues.delete(resourceId);
        releaseMine?.();
      },
    };
  }
}

// waitFor answers whether the promise settled inside the window, leaving no timer
// behind either way.
async function waitFor(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), expiry]);
  } finally {
    clearTimeout(timer);
  }
}
