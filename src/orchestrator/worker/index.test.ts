import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadConfig } from '../../config.js';
import { createWorkerRunner } from './index.js';
import { DaytonaWorkerRunner } from './daytona-worker.js';
import { FreestyleWorkerRunner } from './freestyle-worker.js';
import { MockWorkerRunner } from './mock-worker.js';
import { TenkiWorkerRunner } from './tenki-worker.js';

describe('createWorkerRunner', () => {
  // Only named real providers spend money on a sandbox, so anything else has to
  // land on the mock rather than being treated as a real runner.
  const cases: Array<{ name: string; runner: string; want: unknown }> = [
    {
      name: 'When the runner is `tenki` then should build the tenki runner',
      runner: 'tenki',
      want: TenkiWorkerRunner,
    },
    {
      name: 'When the runner is `freestyle` then should build the Freestyle runner',
      runner: 'freestyle',
      want: FreestyleWorkerRunner,
    },
    {
      name: 'When the runner is `daytona` then should build the Daytona runner',
      runner: 'daytona',
      want: DaytonaWorkerRunner,
    },
    {
      name: 'When the runner is `mock` then should build the mock runner',
      runner: 'mock',
      want: MockWorkerRunner,
    },
    {
      name: 'When the runner is not a known one then should build the mock runner',
      runner: 'nope',
      want: MockWorkerRunner,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const config = loadConfig();
      config.worker.runner = testCase.runner as typeof config.worker.runner;

      assert.ok(createWorkerRunner(config) instanceof (testCase.want as new () => unknown));
    });
  }
});
