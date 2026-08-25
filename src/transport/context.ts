import type { AppConfig } from '../config.js';
import type { EngineCommands } from '../orchestrator/engine-commands.js';
import type { Store } from '../store/store.js';

export interface ApiContext {
  config: AppConfig;
  store: Store;
  commands: EngineCommands;
  appVersion?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export type ServerContext = ApiContext & { appVersion: string };
