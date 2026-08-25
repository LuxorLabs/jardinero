import { type AppConfig, configuredRepositoryNames } from '../config.js';
import type { Store } from '../store/store.js';

// registerConfiguredRepositories creates the row of every repository the config names, so
// a trigger that carries no repository still has one to point at.
export function registerConfiguredRepositories(store: Store, config: AppConfig): string[] {
  const registered = configuredRepositoryNames(config);
  for (const name of registered) store.upsertRepository(name);
  return registered;
}
