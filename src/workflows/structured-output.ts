// findMarkedJsonObject pulls a marker-prefixed JSON payload out of free-form agent
// output, which agents wrap in prose and often fence.
export function findMarkedJsonObject(
  text: string,
  marker: string,
  shaped?: (value: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  let fallback: Record<string, unknown> | undefined;
  for (const index of markerIndexes(text, marker).reverse()) {
    for (const candidate of markedCandidates(text.slice(index + marker.length))) {
      const parsed = parseJsonObject(candidate.text);
      if (!parsed) continue;
      if (!shaped || shaped(parsed)) return parsed;
      // Only the payload itself may stand in for a shape nobody matched. A payload that
      // does not parse still leaves inner objects that do, and answering with one of those
      // reports the agent as having said something it never said.
      if (candidate.isPayload) fallback ??= parsed;
    }
  }
  return fallback;
}

// markedCandidates lists what could be the payload after a marker, saying of each whether
// it is the payload or something found deeper in the text.
function* markedCandidates(rest: string): Generator<{ text: string; isPayload: boolean }> {
  for (const fenced of fencedCodeBlocks(rest)) yield { text: fenced, isPayload: true };
  const payload = rest.trimStart();
  for (const object of balancedObjectStrings(rest)) {
    yield { text: object, isPayload: payload.startsWith(object) };
  }
}

// findShapedJsonObject is the fallback for an agent that emitted the payload without
// its marker.
export function findShapedJsonObject(
  text: string,
  shaped: (value: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  for (const candidate of [...fencedCodeBlocks(text), ...balancedObjectStrings(text)]) {
    const parsed = parseJsonObject(candidate);
    if (parsed && shaped(parsed)) return parsed;
  }
  return undefined;
}

function markerIndexes(text: string, marker: string): number[] {
  const indexes: number[] = [];
  let offset = 0;
  for (;;) {
    const index = text.indexOf(marker, offset);
    if (index < 0) return indexes;
    indexes.push(index);
    offset = index + marker.length;
  }
}

function* fencedCodeBlocks(text: string): Generator<string> {
  const pattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(pattern)) {
    yield match[1].trim();
  }
}

function balancedObjectStrings(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
