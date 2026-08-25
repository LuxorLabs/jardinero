import type { PromptSegment } from '../types.js';

// Key of the one segment operators may override. Must match the key the per-workflow
// guidance builders emit, or an override would silently apply to nothing.
export const EDITABLE_PROMPT_SEGMENT = 'guidance';

// segment is one ordered piece of a worker prompt. Exactly one per agent is editable,
// keyed EDITABLE_PROMPT_SEGMENT; the rest carry context and the output contract.
export function segment(
  key: string,
  title: string,
  editable: boolean,
  lines: string[],
): PromptSegment {
  return { key, title, editable, text: lines.join('\n') };
}
