import type { SandboxRunState, WorkflowStateTone } from '@shared';

// TONE_PILL maps the tones the API sends to the pill families of the theme. Waiting
// shares the working family: an instance that waits is not a problem to look at.
export const TONE_PILL: Record<WorkflowStateTone, string> = {
  working: 'running',
  waiting: 'pending',
  attention: 'failed',
  closed: 'neutral',
  done: 'succeeded',
};

// RUN_STATE_PILL maps a sandbox run state to a pill family; the states the theme
// already names keep their own.
export const RUN_STATE_PILL: Record<SandboxRunState, string> = {
  pending: 'pending',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  aborted: 'aborted',
  orphaned: 'orphaned',
  skipped: 'skipped',
};

// EVENT_FAMILY_TEXT maps the five event families to a text colour, so a log is scanned
// by prefix instead of read line by line.
export const EVENT_FAMILY_TEXT: Record<string, string> = {
  workflow: 'text-warning-fg',
  sandbox: 'text-success-fg',
  agent: 'text-info-fg',
  orchestrator: 'text-muted-foreground',
  operator: 'text-danger-fg',
};
