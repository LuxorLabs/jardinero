import { findMarkedJsonObject } from '../structured-output.js';

export const ROUTING_JSON_MARKER = 'ROUTING_JSON:';

export type RoutedSubjectType = 'linear_issue' | 'pull_request' | 'log_target';

export interface Routing {
  subjectType?: RoutedSubjectType;
  subjectExternalId?: string;
  repositoryFullName?: string;
  resolutionNote?: string;
  raw: Record<string, unknown>;
}

export interface RoutingParseResult {
  routing?: Routing;
  rejectionReason?: string;
}

const SUBJECT_TYPES = new Set<RoutedSubjectType>(['linear_issue', 'pull_request', 'log_target']);

// parseRouting reads what the agent emitted after the ROUTING_JSON marker: nothing when
// there is no marker, a reason when the marker is unreadable, and the routing
// otherwise.
export function parseRouting(text: string | undefined): RoutingParseResult {
  if (!text?.trim()) return {};

  const raw = findMarkedJsonObject(
    text,
    ROUTING_JSON_MARKER,
    (value) => 'subject_type' in value || 'resolution_note' in value,
  );
  if (!raw) {
    return text.includes(ROUTING_JSON_MARKER) ? { rejectionReason: 'marker_invalid_json' } : {};
  }

  const subjectType = raw.subject_type;
  if (subjectType !== null && subjectType !== undefined && !isSubjectType(subjectType)) {
    return { rejectionReason: 'invalid_subject_type' };
  }
  // A subject type with no id identifies nothing, so acting on it would send an
  // agent at a subject nobody named.
  const subjectExternalId = text0(raw.subject_external_id);
  if (subjectType && !subjectExternalId) return { rejectionReason: 'subject_without_id' };

  // An answer is either a subject or the questions that stand in its way. With
  // neither, the object is not an answer at all.
  const resolutionNote = text0(raw.resolution_note);
  if (!subjectType && !resolutionNote) return { rejectionReason: 'neither_subject_nor_note' };

  return {
    routing: {
      ...(subjectType ? { subjectType } : {}),
      ...(subjectExternalId ? { subjectExternalId } : {}),
      ...optional('repositoryFullName', text0(raw.repository_full_name)),
      ...optional('resolutionNote', resolutionNote),
      raw,
    },
  };
}

function isSubjectType(value: unknown): value is RoutedSubjectType {
  return typeof value === 'string' && SUBJECT_TYPES.has(value as RoutedSubjectType);
}

function text0(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optional(key: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}
