import { type ClassValue, clsx } from 'clsx';

// Resolves conflicting Tailwind utilities so a later class overrides an earlier
// one that sets the same property, matching the design's override intent. This
// replaces tailwind-merge, whose full-config merge logic (~8.5 KB gz, on every
// route's shared chunk) is far more than the dashboard's small utility
// vocabulary needs. Only classes sharing a conflict group are de-duplicated;
// everything else is preserved, so unrelated utilities never drop out.
function baseGroup(token: string): string | null {
  let base = token.startsWith('-') ? token.slice(1) : token;
  if (base.startsWith('!')) base = base.slice(1);

  const spacing = /^([pm][xytrbles]?)-/.exec(base);
  if (spacing) return spacing[1];

  if (base.startsWith('bg-')) return 'bg';

  if (base === 'border' || /^border-\d/.test(base)) return 'border-w';
  const side = /^border-([trblxy])(?:-|$)/.exec(base);
  if (side) return `bw-${side[1]}`;
  if (base.startsWith('border-')) return 'border-color';

  if (/^text-(?:left|center|right|justify|start|end)$/.test(base)) return 'text-align';
  if (/^text-(?:xs|sm|base|lg|xl|\dxl)$/.test(base)) return 'font-size';
  if (/^text-\[[^\]]*(?:px|rem|em|%|ch|vh|vw|pt)/.test(base)) return 'font-size';
  if (base.startsWith('text-')) return 'text-color';

  if (/^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/.test(base))
    return 'font-weight';
  if (/^font-\[/.test(base)) return 'font-weight';

  if (base.startsWith('whitespace-')) return 'whitespace';
  if (base.startsWith('items-')) return 'items';
  if (base.startsWith('justify-')) return 'justify';

  return null;
}

// Group key includes the variant chain (hover:, before:, focus-visible:, ...)
// so e.g. `hover:bg-x` never conflicts with an unprefixed `bg-y`. The ':'
// splitting the variant chain from the utility is only counted at bracket depth
// zero, so arbitrary variants like `supports-[display:grid]:` stay intact.
function groupKey(token: string): string | null {
  let depth = 0;
  let lastColon = -1;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    else if (ch === ':' && depth === 0) lastColon = i;
  }
  const variant = lastColon >= 0 ? token.slice(0, lastColon + 1) : '';
  const base = baseGroup(token.slice(lastColon + 1));
  return base === null ? null : variant + base;
}

export function cn(...inputs: ClassValue[]): string {
  const tokens = clsx(inputs).split(' ').filter(Boolean);
  const lastIndexByGroup = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    const key = groupKey(tokens[i]);
    if (key !== null) lastIndexByGroup.set(key, i);
  }
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const key = groupKey(tokens[i]);
    if (key === null || lastIndexByGroup.get(key) === i) out.push(tokens[i]);
  }
  return out.join(' ');
}
