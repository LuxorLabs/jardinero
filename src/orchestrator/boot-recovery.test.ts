import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../store/store.js';
import {
  createFakeWorkflowEngines,
  openInstancesFor,
  type FakePeriodicallyCheckedWorkflow,
  type FakeWorkflowEngines,
  type WorkflowInstanceOpeners,
} from '../testing/state-machines.js';
import { createTestStore } from '../testing/store.js';
import { recoverOpenInstancesAfterBoot } from './boot-recovery.js';

let store: Store;
let cleanup: () => void;
let engines: FakeWorkflowEngines;
let repositoryId: string;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
  repositoryId = store.upsertRepository('acme/web.app').id;
  engines = createFakeWorkflowEngines();
});

afterEach(() => {
  cleanup();
});

describe('recoverOpenInstancesAfterBoot', () => {
  const cases: RecoveryCase[] = [
    {
      name: 'When a request is open then should hand it to the request router',
      open: (fixture) => fixture.openRequest(),
      engineOf: (all) => all.requestRouter,
      want: { recovered: true },
    },
    {
      name: 'When a ticket is open then should hand it to the linear implementer',
      open: (fixture) => fixture.openLinearImplementer(),
      engineOf: (all) => all.linearImplementer,
      want: { recovered: true },
    },
    {
      name: 'When a finding is open then should hand it to the fix implementer',
      open: (fixture) => fixture.openFixImplementer(),
      engineOf: (all) => all.fixImplementer,
      want: { recovered: true },
    },
    {
      name: 'When a pull request is open then should hand it to the pr maintainer',
      open: (fixture) => fixture.openPrMaintainer(),
      engineOf: (all) => all.prMaintainer,
      want: { recovered: true },
    },
    {
      name: 'When a scan is open then should hand it to the log reviewer',
      open: (fixture) => fixture.openLogReviewer(),
      engineOf: (all) => all.logReviewer,
      want: { recovered: true },
    },
    // An ending is not something a restart has to think about.
    {
      name: 'When the request already resolved then should skip it',
      open: (fixture) => fixture.openRequest(),
      close: (id) => store.setRequestState(id, 'rr_resolved'),
      engineOf: (all) => all.requestRouter,
      want: { recovered: false },
    },
    {
      name: 'When the ticket already ended then should skip it',
      open: (fixture) => fixture.openLinearImplementer(),
      close: (id) => store.setLinearImplementerState(id, 'li_done'),
      engineOf: (all) => all.linearImplementer,
      want: { recovered: false },
    },
    {
      name: 'When the finding already ended then should skip it',
      open: (fixture) => fixture.openFixImplementer(),
      close: (id) => store.setFixImplementerState(id, 'fi_done'),
      engineOf: (all) => all.fixImplementer,
      want: { recovered: false },
    },
    {
      name: 'When the pull request already merged then should skip it',
      open: (fixture) => fixture.openPrMaintainer(),
      close: (id) => store.setPrMaintainerState(id, 'prm_merged'),
      engineOf: (all) => all.prMaintainer,
      want: { recovered: false },
    },
    {
      name: 'When the scan already finished then should skip it',
      open: (fixture) => fixture.openLogReviewer(),
      close: (id) => store.setLogReviewerState(id, 'lr_done'),
      engineOf: (all) => all.logReviewer,
      want: { recovered: false },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const workflowInstanceId = c.open(openInstancesFor(store, repositoryId));
      c.close?.(workflowInstanceId);

      await recoverOpenInstancesAfterBoot(store, engines);

      assert.deepEqual(c.engineOf(engines).recovered, c.want.recovered ? [workflowInstanceId] : []);
    });
  }

  test('When nothing is open then should hand nothing over', async () => {
    await recoverOpenInstancesAfterBoot(store, engines);

    assert.deepEqual(everyRecovered(engines), []);
  });

  // The rest of the system has to come up, and the periodic check gets another
  // go at whatever did not recover here.
  test('When a machine reports a failure then should carry on with the rest', async () => {
    const failing = openInstancesFor(store, repositoryId).openPrMaintainer(4688);
    const other = openInstancesFor(store, repositoryId).openPrMaintainer(4691);
    engines.prMaintainer.failsFor = failing;

    await recoverOpenInstancesAfterBoot(store, engines);

    assert.deepEqual([...engines.prMaintainer.recovered].sort(), [failing, other].sort());
  });

  test('When a machine throws then should carry on with the rest', async () => {
    const throwing = openInstancesFor(store, repositoryId).openPrMaintainer(4688);
    const other = openInstancesFor(store, repositoryId).openPrMaintainer(4691);
    engines.prMaintainer.throwsFor = throwing;

    await recoverOpenInstancesAfterBoot(store, engines);

    assert.deepEqual([...engines.prMaintainer.recovered].sort(), [throwing, other].sort());
  });

  test('When one machine throws then should still reach the machines after it', async () => {
    const throwing = openInstancesFor(store, repositoryId).openRequest();
    engines.requestRouter.throwsFor = throwing;
    const pullRequest = openInstancesFor(store, repositoryId).openPrMaintainer();

    await recoverOpenInstancesAfterBoot(store, engines);

    assert.deepEqual(engines.prMaintainer.recovered, [pullRequest]);
  });
});

function everyRecovered(all: FakeWorkflowEngines): string[] {
  return [
    ...all.requestRouter.recovered,
    ...all.linearImplementer.recovered,
    ...all.fixImplementer.recovered,
    ...all.prMaintainer.recovered,
    ...all.logReviewer.recovered,
  ];
}

interface RecoveryCase {
  name: string;
  open: (fixture: WorkflowInstanceOpeners) => string;
  close?: (workflowInstanceId: string) => void;
  engineOf: (all: FakeWorkflowEngines) => FakePeriodicallyCheckedWorkflow<string>;
  want: { recovered: boolean };
}
