import type { RequestRouter } from '../../store/types.js';

// requestRouterPayload carries what the person wrote and where, which is all there is
// before the subject is known.
export function requestRouterPayload(instance: RequestRouter): Record<string, unknown> {
  return {
    request_source: instance.requestSource,
    ...optional('request_text', instance.requestText),
  };
}

function optional(key: string, value: string | null): Record<string, unknown> {
  return value === null ? {} : { [key]: value };
}
