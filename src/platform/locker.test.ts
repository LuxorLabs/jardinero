import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Lock, Locker } from './locker.js';
import { InMemoryLocker } from './locker.js';

const SHORT_WAIT_MS = 20;

describe('InMemoryLocker.acquire', () => {
  const cases: AcquireCase[] = [
    {
      name: 'When the resource is free then should hand the lock over at once',
      want: { granted: true },
    },
    {
      // This is the whole point: two events for one subject are handled one
      // after the other however they arrived.
      name: 'When the resource is held then should make the caller wait',
      arrange: async (locker) => {
        await locker.acquire('pr:1');
      },
      want: { granted: false },
    },
    {
      name: 'When another resource is held then should not make this one wait',
      arrange: async (locker) => {
        await locker.acquire('pr:2');
      },
      want: { granted: true },
    },
    {
      // A resource nobody holds has to be free again, or an entry point would
      // wait on whoever touched the subject before it.
      name: 'When everyone released then should hand the resource over at once again',
      arrange: async (locker) => {
        (await locker.acquire('pr:1'))?.release();
      },
      want: { granted: true },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const locker = new InMemoryLocker(SHORT_WAIT_MS);
      await c.arrange?.(locker);

      const acquiring = locker.acquire('pr:1');

      assert.equal((await settled(acquiring)) !== undefined, c.want.granted);
      await acquiring;
    });
  }

  test('When several callers queue then should serve them in the order they asked', async () => {
    const locker = new InMemoryLocker();
    const order: number[] = [];
    const held = await locker.acquire('pr:1');
    assert.ok(held);

    const queued = [1, 2, 3].map((position) =>
      locker.acquire('pr:1').then((lock) => {
        order.push(position);
        lock?.release();
      }),
    );
    held.release();
    await Promise.all(queued);

    assert.deepEqual(order, [1, 2, 3]);
  });

  // Releasing twice would hand the resource to two waiters at once.
  test('When a lock is released twice then should let only one waiter through', async () => {
    const locker = new InMemoryLocker(SHORT_WAIT_MS);
    const held = await locker.acquire('pr:1');
    assert.ok(held);
    const first = locker.acquire('pr:1');
    const second = locker.acquire('pr:1');

    held.release();
    held.release();

    assert.ok(await first);
    assert.equal(await second, undefined);
  });

  // A handler that never releases would take the subject hostage forever, so the
  // wait gives up and the caller is told instead of hanging.
  test('When the wait runs out then should answer without the lock', async () => {
    const locker = new InMemoryLocker(5);
    await locker.acquire('pr:1');

    assert.equal(await locker.acquire('pr:1'), undefined);
  });

  test('When the holder released before the wait ran out then should hand the lock over', async () => {
    const locker = new InMemoryLocker(1_000);
    const held = await locker.acquire('pr:1');
    assert.ok(held);

    const waiting = locker.acquire('pr:1');
    held.release();

    assert.ok(await waiting);
  });
});

// Resolves to the lock when the promise has already settled, and to undefined
// when it is still waiting. Polling beats a fixed timeout, which would only be
// a slower way to ask the same question.
function settled(pending: Promise<Lock | undefined>): Promise<Lock | undefined> {
  return Promise.race([
    pending,
    new Promise<undefined>((resolve) => setImmediate(() => resolve(undefined))),
  ]);
}

interface AcquireCase {
  name: string;
  arrange?: (locker: Locker) => Promise<void>;
  want: { granted: boolean };
}
