import type { HandlerResponse } from '../respond.js';

export interface HealthContext {
  store: { countRunningSandboxRuns(): number };
  appVersion: string;
}

export function healthResponse(context: HealthContext): HandlerResponse {
  return {
    status: 200,
    body: {
      ok: true,
      running: context.store.countRunningSandboxRuns(),
      version: context.appVersion,
    },
  };
}
