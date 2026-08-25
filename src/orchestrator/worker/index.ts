import type { AppConfig } from '../../config.js';
import type { SandboxRunner } from '../sandbox-pool.js';
import { MockWorkerRunner } from './mock-worker.js';
import { TenkiWorkerRunner } from './tenki-worker.js';

export function createWorkerRunner(config: AppConfig): SandboxRunner {
  if (config.worker.runner === 'tenki') {
    return new TenkiWorkerRunner(config);
  }
  return new MockWorkerRunner();
}
