import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../store/store.js';
import {
  createFakeWorkflowEngines,
  FakePeriodicallyCheckedWorkflow,
  openInstancesFor,
  type FakeWorkflowEngines,
  type WorkflowInstanceOpeners,
} from '../testing/state-machines.js';
import { createTestStore } from '../testing/store.js';
import { PeriodicCheckTimer } from './periodic-check-timer.js';

const TICK_MS = 10_000;

let store: Store;
let cleanup: () => void;
let engines: FakeWorkflowEngines;
let timer: PeriodicCheckTimer;
let repositoryId: string;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
  repositoryId = store.upsertRepository('acme/web.app').id;
  engines = createFakeWorkflowEngines();
  timer = new PeriodicCheckTimer(store, engines, { tickMs: TICK_MS });
});

afterEach(() => {
  timer.stop();
  cleanup();
});

describe('PeriodicCheckTimer.checkInstancesDueNow', () => {
  const cases: BeatCase[] = [
    {
      name: 'When a request is due then should hand it to the request router',
      open: (fixture) => fixture.openRequest(),
      engineOf: (all) => all.requestRouter,
    },
    {
      name: 'When a ticket is due then should hand it to the linear implementer',
      open: (fixture) => fixture.openLinearImplementer(),
      engineOf: (all) => all.linearImplementer,
    },
    {
      name: 'When a finding is due then should hand it to the fix implementer',
      open: (fixture) => fixture.openFixImplementer(),
      engineOf: (all) => all.fixImplementer,
    },
    {
      name: 'When a pull request is due then should hand it to the pr maintainer',
      open: (fixture) => fixture.openPrMaintainer(),
      engineOf: (all) => all.prMaintainer,
    },
    {
      name: 'When a scan is due then should hand it to the log reviewer',
      open: (fixture) => fixture.openLogReviewer(),
      engineOf: (all) => all.logReviewer,
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const workflowInstanceId = c.open(openInstancesFor(store, repositoryId));

      await timer.checkInstancesDueNow();

      assert.deepEqual(c.engineOf(engines).checked, [workflowInstanceId]);
    });
  }

  // A state left out of the cadences is never looked at, which is what the
  // states waiting for a person want.
  test('When the state has no cadence then should not hand the instance over', async () => {
    engines.prMaintainer = new FakePeriodicallyCheckedWorkflow({ checkWaitMs: {} });
    openInstancesFor(store, repositoryId).openPrMaintainer();

    await timer.checkInstancesDueNow();

    assert.deepEqual(engines.prMaintainer.checked, []);
  });

  test('When nothing is due then should hand nothing over', async () => {
    await timer.checkInstancesDueNow();

    assert.deepEqual(everyChecked(engines), []);
  });

  test('When several instances are due then should hand over every one of them', async () => {
    const first = openInstancesFor(store, repositoryId).openPrMaintainer(4688);
    const second = openInstancesFor(store, repositoryId).openPrMaintainer(4691);

    await timer.checkInstancesDueNow();

    assert.deepEqual([...engines.prMaintainer.checked].sort(), [first, second].sort());
  });

  // A single stuck subject must not freeze every other one behind it.
  test('When a machine reports a failure then should carry on with the rest', async () => {
    const failing = openInstancesFor(store, repositoryId).openPrMaintainer(4688);
    const other = openInstancesFor(store, repositoryId).openPrMaintainer(4691);
    engines.prMaintainer.failsFor = failing;

    await timer.checkInstancesDueNow();

    assert.deepEqual([...engines.prMaintainer.checked].sort(), [failing, other].sort());
  });

  test('When a machine throws then should carry on with the rest', async () => {
    const throwing = openInstancesFor(store, repositoryId).openPrMaintainer(4688);
    const other = openInstancesFor(store, repositoryId).openPrMaintainer(4691);
    engines.prMaintainer.throwsFor = throwing;

    await timer.checkInstancesDueNow();

    assert.deepEqual([...engines.prMaintainer.checked].sort(), [throwing, other].sort());
  });

  test('When one machine throws then should still reach the machines after it', async () => {
    const throwing = openInstancesFor(store, repositoryId).openRequest();
    engines.requestRouter.throwsFor = throwing;
    const pullRequest = openInstancesFor(store, repositoryId).openPrMaintainer();

    await timer.checkInstancesDueNow();

    assert.deepEqual(engines.prMaintainer.checked, [pullRequest]);
  });

  // A beat that outlives its interval must not pile up on the next one, which
  // would ask GitHub twice for the same instance.
  test('When a beat is still running then should skip the next one', async () => {
    const workflowInstanceId = openInstancesFor(store, repositoryId).openPrMaintainer();
    let releaseCheck: (() => void) | undefined;
    engines.prMaintainer.onPeriodicCheck = (id) => {
      engines.prMaintainer.checked.push(id);
      return new Promise((resolve) => {
        releaseCheck = () => resolve(undefined);
      });
    };
    const first = timer.checkInstancesDueNow();
    await until(() => engines.prMaintainer.checked.length > 0);

    await timer.checkInstancesDueNow();

    assert.deepEqual(engines.prMaintainer.checked, [workflowInstanceId]);
    releaseCheck?.();
    await first;
  });
});

describe('PeriodicCheckTimer.start', () => {
  test('When it is started then should beat on its own', async () => {
    const beating = new PeriodicCheckTimer(store, engines, { tickMs: 1 });
    const workflowInstanceId = openInstancesFor(store, repositoryId).openPrMaintainer();

    beating.start();

    await until(() => engines.prMaintainer.checked.length > 0);
    beating.stop();
    assert.deepEqual(engines.prMaintainer.checked.slice(0, 1), [workflowInstanceId]);
  });

  test('When it is started twice then should keep a single beat', () => {
    timer.start();

    assert.doesNotThrow(() => timer.start());
  });
});

describe('PeriodicCheckTimer.stop', () => {
  test('When it is stopped then should beat no more', async () => {
    const beating = new PeriodicCheckTimer(store, engines, { tickMs: 1 });
    openInstancesFor(store, repositoryId).openPrMaintainer();
    beating.start();
    await until(() => engines.prMaintainer.checked.length > 0);

    beating.stop();
    const beatsWhenStopped = engines.prMaintainer.checked.length;
    await sleep(20);

    assert.equal(engines.prMaintainer.checked.length, beatsWhenStopped);
  });

  test('When it is stopped without having started then should do nothing', () => {
    assert.doesNotThrow(() => timer.stop());
  });
});

function everyChecked(all: FakeWorkflowEngines): string[] {
  return [
    ...all.requestRouter.checked,
    ...all.linearImplementer.checked,
    ...all.fixImplementer.checked,
    ...all.prMaintainer.checked,
    ...all.logReviewer.checked,
  ];
}

// Polling beats a fixed wait, which would only be a slower way to ask the same
// question.
async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !condition(); turn += 1) await sleep(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BeatCase {
  name: string;
  open: (fixture: WorkflowInstanceOpeners) => string;
  engineOf: (all: FakeWorkflowEngines) => FakePeriodicallyCheckedWorkflow<string>;
}
